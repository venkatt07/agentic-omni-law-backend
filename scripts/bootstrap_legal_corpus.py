#!/usr/bin/env python3
"""
Bootstrap a minimal offline legal corpus for AGENTIC OMNI LAW.

Features:
- resumable downloads (HTTP range when supported)
- idempotent reruns (manifest + existence checks)
- per-source license/attribution tracking
- starter pack controls for Acts / SC / HC datasets
- PDF text extraction (pdfminer.six), with needs_ocr flag when weak extraction
- fail-safe execution (continue on source failures)
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import traceback
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin

import requests

try:
    from pdfminer.high_level import extract_text as pdf_extract_text  # type: ignore
except Exception:  # pragma: no cover
    pdf_extract_text = None
try:
    from pypdf import PdfReader  # type: ignore
except Exception:  # pragma: no cover
    PdfReader = None


USER_AGENT = "agentic-omni-law-legal-corpus-bootstrapper/1.0"
TIMEOUT = (15, 180)
CHUNK_SIZE = 1024 * 256


@dataclass
class DownloadResult:
    ok: bool
    path: Optional[Path] = None
    skipped: bool = False
    bytes_written: int = 0
    sha256: Optional[str] = None
    error: Optional[str] = None


def now_iso() -> str:
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def safe_mkdir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def read_json(p: Path, default: Any) -> Any:
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(p: Path, data: Any) -> None:
    safe_mkdir(p.parent)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def file_sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sanitize_filename(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "file"


def ensure_layout(out_dir: Path) -> Dict[str, Path]:
    dirs = {
        "root": out_dir,
        "acts": out_dir / "Acts",
        "sc": out_dir / "CaseLaw" / "SC",
        "hc": out_dir / "CaseLaw" / "HC",
        "meta": out_dir / "Metadata",
        "manifests": out_dir / "Metadata" / "manifests",
        "cache_tmp": out_dir / "Cache" / "tmp",
        "cache_logs": out_dir / "Cache" / "logs",
    }
    for d in dirs.values():
        safe_mkdir(d)
    return dirs


def init_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT})
    return s


def log_line(log_file: Path, line: str) -> None:
    safe_mkdir(log_file.parent)
    with log_file.open("a", encoding="utf-8") as f:
        f.write(f"[{now_iso()}] {line}\n")


def download_with_resume(
    session: requests.Session,
    url: str,
    dest: Path,
    tmp_dir: Path,
    dry_run: bool = False,
    force: bool = False,
) -> DownloadResult:
    safe_mkdir(dest.parent)
    safe_mkdir(tmp_dir)

    if dry_run:
        return DownloadResult(ok=True, path=dest, skipped=True, bytes_written=0)

    if dest.exists() and not force:
        return DownloadResult(ok=True, path=dest, skipped=True, bytes_written=0, sha256=file_sha256(dest))

    partial = tmp_dir / (dest.name + ".part")
    resume_from = partial.stat().st_size if partial.exists() else 0
    headers = {}
    if resume_from > 0:
        headers["Range"] = f"bytes={resume_from}-"

    try:
        with session.get(url, stream=True, timeout=TIMEOUT, headers=headers) as r:
            if resume_from > 0 and r.status_code not in (206, 200):
                return DownloadResult(ok=False, error=f"range resume failed: HTTP {r.status_code}")
            if resume_from == 0 and r.status_code >= 400:
                return DownloadResult(ok=False, error=f"HTTP {r.status_code}")
            mode = "ab" if (resume_from > 0 and r.status_code == 206) else "wb"
            if mode == "wb" and partial.exists():
                partial.unlink(missing_ok=True)
            bytes_written = 0
            with partial.open(mode) as f:
                for chunk in r.iter_content(chunk_size=CHUNK_SIZE):
                    if not chunk:
                        continue
                    f.write(chunk)
                    bytes_written += len(chunk)
        shutil.move(str(partial), str(dest))
        return DownloadResult(ok=True, path=dest, bytes_written=bytes_written, sha256=file_sha256(dest))
    except Exception as e:
        return DownloadResult(ok=False, error=str(e))


def extract_pdf_to_txt(pdf_path: Path, txt_path: Path) -> Dict[str, Any]:
    result = {"ok": False, "chars": 0, "needs_ocr": False, "error": None}
    if pdf_extract_text is None and PdfReader is None:
        result["error"] = "no_pdf_extractor_available"
        result["needs_ocr"] = True
        return result
    try:
        text = ""
        if pdf_extract_text is not None:
            try:
                text = pdf_extract_text(str(pdf_path)) or ""
            except Exception:
                text = ""
        if not text and PdfReader is not None:
            try:
                rdr = PdfReader(str(pdf_path))
                text = "\n".join((pg.extract_text() or "") for pg in rdr.pages)
            except Exception:
                text = ""
        text = re.sub(r"\s+\n", "\n", text)
        text = re.sub(r"[ \t]+", " ", text).strip()
        safe_mkdir(txt_path.parent)
        txt_path.write_text(text, encoding="utf-8", errors="ignore")
        result["ok"] = True
        result["chars"] = len(text)
        result["needs_ocr"] = len(text) < 400
        return result
    except Exception as e:
        result["error"] = str(e)
        result["needs_ocr"] = True
        return result


def build_doc_meta(
    source_id: str,
    source_url: str,
    target_path: Path,
    kind: str,
    license_name: str,
    attribution: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    data = {
        "doc_id": target_path.stem,
        "kind": kind,
        "source_id": source_id,
        "source_url": source_url,
        "path": str(target_path),
        "title": target_path.stem,
        "court": "Supreme Court" if kind == "sc" else ("High Court" if kind == "hc" else None),
        "date": None,
        "citation": None,
        "license": license_name,
        "attribution": attribution,
        "downloaded_at": now_iso(),
    }
    if extra:
        data.update(extra)
    return data


def write_doc_meta(meta_dir: Path, target_path: Path, payload: Dict[str, Any]) -> None:
    meta_path = meta_dir / (target_path.name + ".meta.json")
    write_json(meta_path, payload)


def select_acts_files(files: List[Dict[str, Any]], allow_patterns: List[str], limit: int, prefer_ext: List[str]) -> List[Dict[str, Any]]:
    pats = [p.lower() for p in allow_patterns]

    def score(f: Dict[str, Any]) -> Tuple[int, int]:
        name = str(f.get("key") or f.get("filename") or "").lower()
        pat_hits = sum(1 for p in pats if p in name)
        ext_rank = 0
        for i, ext in enumerate(prefer_ext):
            if name.endswith(ext.lower()):
                ext_rank = len(prefer_ext) - i
                break
        return (pat_hits, ext_rank)

    ranked = sorted(files, key=score, reverse=True)
    chosen = []
    for f in ranked:
        name = str(f.get("key") or f.get("filename") or "")
        if not name:
            continue
        if pats and not any(p in name.lower() for p in pats):
            continue
        chosen.append(f)
        if len(chosen) >= limit:
            break
    if len(chosen) < limit:
        for f in ranked:
            if f in chosen:
                continue
            chosen.append(f)
            if len(chosen) >= limit:
                break
    return chosen[:limit]


def list_zenodo_files(session: requests.Session, record_api_url: str) -> List[Dict[str, Any]]:
    r = session.get(record_api_url, timeout=TIMEOUT)
    r.raise_for_status()
    j = r.json()
    files = []
    for f in j.get("files", []):
        name = f.get("key") or f.get("filename")
        links = f.get("links") or {}
        url = links.get("self") or links.get("download")
        if name and url:
            files.append(
                {
                    "filename": name,
                    "url": url,
                    "size": f.get("size"),
                    "checksum": f.get("checksum"),
                }
            )
    return files


def try_aws_cli_download(
    s3_uri: str,
    target_dir: Path,
    max_items: int,
    dry_run: bool,
    force: bool,
) -> Dict[str, Any]:
    result = {"ok": False, "used": False, "downloaded": 0, "failed": 0, "items": []}
    python_bin = sys.executable
    if not python_bin:
        return result
    result["used"] = True
    try:
        cmd = [python_bin, "-m", "awscli", "s3", "ls", s3_uri, "--recursive", "--no-sign-request"]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            return result
        lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
        keys = []
        for ln in lines:
            parts = ln.split()
            if len(parts) < 4:
                continue
            key = " ".join(parts[3:])
            keys.append(key)
            if len(keys) >= max_items:
                break
        for key in keys:
            name = sanitize_filename(os.path.basename(key))
            dest = target_dir / name
            if dest.exists() and not force:
                continue
            if dry_run:
                result["downloaded"] += 1
                result["items"].append({"filename": name, "s3_key": key, "dry_run": True})
                continue
            cp_cmd = [python_bin, "-m", "awscli", "s3", "cp", f"{s3_uri.rstrip('/')}/{key}", str(dest), "--no-sign-request"]
            cp = subprocess.run(cp_cmd, capture_output=True, text=True, check=False)
            if cp.returncode == 0:
                result["downloaded"] += 1
                result["items"].append({"filename": name, "s3_key": key, "path": str(dest)})
            else:
                result["failed"] += 1
                result["items"].append({"filename": name, "s3_key": key, "error": cp.stderr.strip()[:500]})
        result["ok"] = True
        return result
    except Exception:
        return result


def parse_simple_manifest(lines: Iterable[str], http_base: str, max_items: int) -> List[Dict[str, str]]:
    out = []
    for ln in lines:
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        if ln.startswith("http://") or ln.startswith("https://"):
            url = ln
            filename = sanitize_filename(url.split("/")[-1])
        else:
            filename = sanitize_filename(os.path.basename(ln))
            url = urljoin(http_base.rstrip("/") + "/", ln.lstrip("/"))
        out.append({"filename": filename, "url": url})
        if len(out) >= max_items:
            break
    return out


def update_sources_json(meta_sources_path: Path, source_row: Dict[str, Any]) -> None:
    payload = read_json(meta_sources_path, {"sources": []})
    sources = payload.get("sources", [])
    sources = [s for s in sources if s.get("id") != source_row.get("id")]
    sources.append(source_row)
    payload["sources"] = sources
    payload["updated_at"] = now_iso()
    write_json(meta_sources_path, payload)


def run_indexing_hook(out_dir: Path, log_file: Path, dry_run: bool) -> Dict[str, Any]:
    """
    Hook to existing project indexing pipeline.
    Current implementation:
    - writes a corpus_index_manifest.json with chunk metadata placeholders
    - optionally calls `npm run ai:verify` for runtime visibility
    """
    manifest_path = out_dir / "Metadata" / "corpus_index_manifest.json"
    files = []
    for folder in [out_dir / "Acts", out_dir / "CaseLaw" / "SC", out_dir / "CaseLaw" / "HC"]:
        if not folder.exists():
            continue
        for p in folder.rglob("*.txt"):
            files.append(p)
    chunk_rows = []
    for p in files:
        text = p.read_text(encoding="utf-8", errors="ignore")
        text = re.sub(r"\s+", " ", text).strip()
        size = 1000
        overlap = 150
        i = 0
        idx = 0
        while i < len(text):
            chunk = text[i : i + size]
            if not chunk:
                break
            chunk_rows.append(
                {
                    "doc_id": p.stem,
                    "chunk_id": f"{p.stem}:{idx}",
                    "source_path": str(p),
                    "offset_start": i,
                    "offset_end": i + len(chunk),
                    "chars": len(chunk),
                }
            )
            idx += 1
            i += max(1, size - overlap)
    write_json(
        manifest_path,
        {
            "generated_at": now_iso(),
            "documents_txt": len(files),
            "chunks_estimated": len(chunk_rows),
            "chunks": chunk_rows[:20000],
            "note": "This manifest is a bootstrap hook. Use existing backend index pipeline for vector embedding ingestion.",
        },
    )
    if dry_run:
        return {"ok": True, "documents_txt": len(files), "chunks_estimated": len(chunk_rows), "hook": "dry_run"}
    try:
        proc = subprocess.run(
            ["npm", "run", "ai:verify"],
            cwd=str(Path(__file__).resolve().parents[1]),
            capture_output=True,
            text=True,
            check=False,
        )
        log_line(log_file, f"index_hook ai:verify exit={proc.returncode}")
        return {
            "ok": proc.returncode == 0,
            "documents_txt": len(files),
            "chunks_estimated": len(chunk_rows),
            "hook": "manifest+ai_verify",
            "verify_exit": proc.returncode,
        }
    except Exception as e:
        log_line(log_file, f"index_hook error: {e}")
        return {"ok": False, "documents_txt": len(files), "chunks_estimated": len(chunk_rows), "hook": "manifest_only", "error": str(e)}


def process_downloaded_file(
    source_id: str,
    kind: str,
    license_name: str,
    attribution: str,
    source_url: str,
    file_path: Path,
    source_folder: Path,
    dry_run: bool,
) -> Dict[str, Any]:
    meta_dir = source_folder / "_meta"
    txt_target = source_folder / (file_path.stem + ".txt")
    extra: Dict[str, Any] = {}
    extract = None
    if file_path.suffix.lower() == ".pdf":
        extract = {"ok": False, "chars": 0, "needs_ocr": True, "error": "dry_run"}
        if not dry_run:
            extract = extract_pdf_to_txt(file_path, txt_target)
        extra["text_extracted"] = bool(extract.get("ok"))
        extra["text_path"] = str(txt_target if txt_target.exists() else "")
        extra["text_chars"] = int(extract.get("chars") or 0)
        extra["needs_ocr"] = bool(extract.get("needs_ocr"))
        extra["extract_error"] = extract.get("error")
    elif file_path.suffix.lower() in (".txt", ".json", ".csv"):
        if file_path.suffix.lower() == ".txt":
            txt_target = file_path
        elif not dry_run:
            txt_target.write_text(file_path.read_text(encoding="utf-8", errors="ignore"), encoding="utf-8")
        extra["text_extracted"] = True
        extra["text_path"] = str(txt_target)
        extra["text_chars"] = len(txt_target.read_text(encoding="utf-8", errors="ignore")) if txt_target.exists() else 0
        extra["needs_ocr"] = False
    doc_meta = build_doc_meta(source_id, source_url, file_path, kind, license_name, attribution, extra)
    write_doc_meta(meta_dir, file_path, doc_meta)
    return doc_meta


def process_archive_bundle(
    source_id: str,
    kind: str,
    license_name: str,
    attribution: str,
    source_url: str,
    archive_path: Path,
    source_folder: Path,
    dry_run: bool,
) -> Dict[str, Any]:
    out = {"extracted_files": 0, "processed_docs": 0, "texts_extracted": 0}
    if dry_run:
        return out
    extract_dir = source_folder / sanitize_filename(archive_path.stem)
    safe_mkdir(extract_dir)
    try:
        suf = archive_path.suffix.lower()
        if suf == ".zip":
            with zipfile.ZipFile(archive_path, "r") as zf:
                members = [m for m in zf.namelist() if not m.endswith("/")]
                zf.extractall(path=extract_dir)
                out["extracted_files"] = len(members)
        elif suf in {".tar", ".tgz", ".gz"} or archive_path.name.lower().endswith(".tar.gz"):
            mode = "r:gz" if archive_path.name.lower().endswith(".gz") else "r:"
            with tarfile.open(archive_path, mode) as tf:
                members = [m for m in tf.getmembers() if m.isfile()]
                tf.extractall(path=extract_dir)
                out["extracted_files"] = len(members)
        else:
            return out
    except Exception:
        return out
    for p in extract_dir.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in {".pdf", ".txt", ".json", ".csv"}:
            continue
        meta = process_downloaded_file(
            source_id=source_id,
            kind=kind,
            license_name=license_name,
            attribution=attribution,
            source_url=source_url,
            file_path=p,
            source_folder=source_folder,
            dry_run=dry_run,
        )
        out["processed_docs"] += 1
        if meta.get("text_extracted"):
            out["texts_extracted"] += 1
    return out


def run(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir).resolve()
    paths = ensure_layout(out_dir)
    log_file = paths["cache_logs"] / f"bootstrap_{dt.datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.log"
    config_path = Path(args.config).resolve()
    config = read_json(config_path, {})
    sources = config.get("sources", [])
    if not sources:
        print(f"[error] no sources found in {config_path}")
        return 2

    log_line(log_file, "bootstrap start")
    session = init_session()
    results_summary: Dict[str, Any] = {
        "started_at": now_iso(),
        "out_dir": str(out_dir),
        "dry_run": bool(args.dry_run),
        "sources": [],
        "totals": {"downloaded": 0, "skipped": 0, "failed": 0, "texts_extracted": 0},
    }

    explicit_mode = args.acts_only or args.sc_only or args.hc_only
    source_kinds_enabled = set()
    if explicit_mode:
        if args.acts_only:
            source_kinds_enabled.add("acts")
        if args.sc_only:
            source_kinds_enabled.add("sc")
        if args.hc_only:
            source_kinds_enabled.add("hc")
    else:
        # starter/default behavior
        source_kinds_enabled = {"acts", "sc", "hc"}

    for src in sources:
        src_id = src.get("id", "unknown_source")
        kind = src.get("kind")
        if kind not in source_kinds_enabled:
            continue
        if not src.get("enabled", True):
            continue
        src_row = {
            "id": src_id,
            "name": src.get("name"),
            "kind": kind,
            "license": src.get("license"),
            "attribution": src.get("attribution"),
            "downloaded_at": now_iso(),
            "status": "ok",
            "error": None,
            "counts": {"downloaded": 0, "skipped": 0, "failed": 0, "texts_extracted": 0},
            "items": [],
        }
        manifest_path = paths["manifests"] / f"{src_id}.manifest.json"
        try:
            print(f"[source] {src.get('name')} ({src_id})")
            access = src.get("access", {})
            method = access.get("method")
            if method == "zenodo_record_files":
                record_url = access.get("record_api_url")
                files = list_zenodo_files(session, record_url)
                starter = src.get("starter", {})
                limit = args.max_acts if args.max_acts is not None else int(starter.get("default_limit", 30))
                selected = select_acts_files(
                    files,
                    allow_patterns=starter.get("allow_patterns", []),
                    limit=limit,
                    prefer_ext=starter.get("prefer_extensions", [".txt", ".json", ".pdf"]),
                )
                for f in selected:
                    filename = sanitize_filename(f["filename"])
                    target = paths["acts"] / filename
                    dl = download_with_resume(
                        session=session,
                        url=f["url"],
                        dest=target,
                        tmp_dir=paths["cache_tmp"],
                        dry_run=args.dry_run,
                        force=args.force,
                    )
                    if not dl.ok:
                        src_row["counts"]["failed"] += 1
                        src_row["items"].append({"filename": filename, "url": f["url"], "status": "failed", "error": dl.error})
                        continue
                    if dl.skipped:
                        src_row["counts"]["skipped"] += 1
                        src_row["items"].append({"filename": filename, "url": f["url"], "status": "skipped"})
                    else:
                        src_row["counts"]["downloaded"] += 1
                        src_row["items"].append({"filename": filename, "url": f["url"], "status": "downloaded", "sha256": dl.sha256})
                    if not args.dry_run and dl.path and dl.path.exists():
                        if dl.path.suffix.lower() in {".zip", ".tar", ".gz"} or dl.path.name.lower().endswith(".tar.gz"):
                            bundle = process_archive_bundle(
                                source_id=src_id,
                                kind="acts",
                                license_name=src.get("license", ""),
                                attribution=src.get("attribution", ""),
                                source_url=f["url"],
                                archive_path=dl.path,
                                source_folder=paths["acts"],
                                dry_run=args.dry_run,
                            )
                            src_row["counts"]["texts_extracted"] += int(bundle.get("texts_extracted", 0))
                            src_row["items"][-1]["bundle"] = bundle
                        else:
                            meta = process_downloaded_file(
                                source_id=src_id,
                                kind="acts",
                                license_name=src.get("license", ""),
                                attribution=src.get("attribution", ""),
                                source_url=f["url"],
                                file_path=dl.path,
                                source_folder=paths["acts"],
                                dry_run=args.dry_run,
                            )
                            if meta.get("text_extracted"):
                                src_row["counts"]["texts_extracted"] += 1

            elif method == "aws_s3_prefix":
                folder = paths["sc"] if kind == "sc" else paths["hc"]
                max_items = args.max_sc if kind == "sc" else args.max_hc
                starter_default = int(src.get("starter", {}).get("default_limit", 2000 if kind == "sc" else 500))
                max_items = max_items if max_items is not None else starter_default

                aws_try = try_aws_cli_download(
                    s3_uri=access.get("s3_uri", ""),
                    target_dir=folder,
                    max_items=max_items,
                    dry_run=args.dry_run,
                    force=args.force,
                )
                if aws_try["used"] and aws_try["ok"]:
                    src_row["items"].extend(aws_try["items"])
                    src_row["counts"]["downloaded"] += int(aws_try["downloaded"])
                    src_row["counts"]["failed"] += int(aws_try["failed"])
                    if not args.dry_run:
                        for item in aws_try["items"]:
                            p = item.get("path")
                            if not p:
                                continue
                            fpath = Path(p)
                            if not fpath.exists():
                                continue
                            if fpath.suffix.lower() in {".zip", ".tar", ".gz"} or fpath.name.lower().endswith(".tar.gz"):
                                bundle = process_archive_bundle(
                                    source_id=src_id,
                                    kind=kind,
                                    license_name=src.get("license", ""),
                                    attribution=src.get("attribution", ""),
                                    source_url=f"{access.get('s3_uri','').rstrip('/')}/{item.get('s3_key','')}",
                                    archive_path=fpath,
                                    source_folder=folder,
                                    dry_run=args.dry_run,
                                )
                                src_row["counts"]["texts_extracted"] += int(bundle.get("texts_extracted", 0))
                                item["bundle"] = bundle
                            else:
                                meta = process_downloaded_file(
                                    source_id=src_id,
                                    kind=kind,
                                    license_name=src.get("license", ""),
                                    attribution=src.get("attribution", ""),
                                    source_url=f"{access.get('s3_uri','').rstrip('/')}/{item.get('s3_key','')}",
                                    file_path=fpath,
                                    source_folder=folder,
                                    dry_run=args.dry_run,
                                )
                                if meta.get("text_extracted"):
                                    src_row["counts"]["texts_extracted"] += 1
                else:
                    manifest_url = access.get("http_manifest_url", "")
                    http_base = access.get("http_base_url", "")
                    if not manifest_url or not http_base:
                        src_row["status"] = "partial"
                        src_row["error"] = "AWS CLI unavailable or failed, and HTTP fallback not configured (http_manifest_url/http_base_url)."
                    else:
                        r = session.get(manifest_url, timeout=TIMEOUT)
                        r.raise_for_status()
                        listed = parse_simple_manifest(r.text.splitlines(), http_base, max_items=max_items)
                        for item in listed:
                            target = folder / sanitize_filename(item["filename"])
                            dl = download_with_resume(
                                session=session,
                                url=item["url"],
                                dest=target,
                                tmp_dir=paths["cache_tmp"],
                                dry_run=args.dry_run,
                                force=args.force,
                            )
                            if not dl.ok:
                                src_row["counts"]["failed"] += 1
                                src_row["items"].append({"filename": item["filename"], "url": item["url"], "status": "failed", "error": dl.error})
                                continue
                            if dl.skipped:
                                src_row["counts"]["skipped"] += 1
                                src_row["items"].append({"filename": item["filename"], "url": item["url"], "status": "skipped"})
                            else:
                                src_row["counts"]["downloaded"] += 1
                                src_row["items"].append({"filename": item["filename"], "url": item["url"], "status": "downloaded", "sha256": dl.sha256})
                            if not args.dry_run and dl.path and dl.path.exists():
                                if dl.path.suffix.lower() in {".zip", ".tar", ".gz"} or dl.path.name.lower().endswith(".tar.gz"):
                                    bundle = process_archive_bundle(
                                        source_id=src_id,
                                        kind=kind,
                                        license_name=src.get("license", ""),
                                        attribution=src.get("attribution", ""),
                                        source_url=item["url"],
                                        archive_path=dl.path,
                                        source_folder=folder,
                                        dry_run=args.dry_run,
                                    )
                                    src_row["counts"]["texts_extracted"] += int(bundle.get("texts_extracted", 0))
                                    src_row["items"][-1]["bundle"] = bundle
                                else:
                                    meta = process_downloaded_file(
                                        source_id=src_id,
                                        kind=kind,
                                        license_name=src.get("license", ""),
                                        attribution=src.get("attribution", ""),
                                        source_url=item["url"],
                                        file_path=dl.path,
                                        source_folder=folder,
                                        dry_run=args.dry_run,
                                    )
                                    if meta.get("text_extracted"):
                                        src_row["counts"]["texts_extracted"] += 1
            else:
                src_row["status"] = "failed"
                src_row["error"] = f"unsupported access method: {method}"

        except Exception as e:
            src_row["status"] = "failed"
            src_row["error"] = str(e)
            log_line(log_file, f"source_error {src_id}: {traceback.format_exc()}")

        write_json(manifest_path, src_row)
        update_sources_json(paths["meta"] / "sources.json", src_row)
        results_summary["sources"].append(src_row)
        for k in ("downloaded", "skipped", "failed", "texts_extracted"):
            results_summary["totals"][k] += int(src_row["counts"].get(k, 0))

    index_hook = run_indexing_hook(out_dir=out_dir, log_file=log_file, dry_run=args.dry_run)
    results_summary["index_hook"] = index_hook
    results_summary["finished_at"] = now_iso()
    write_json(paths["meta"] / "bootstrap_summary.json", results_summary)

    print("\n=== Legal Corpus Bootstrap Summary ===")
    print(f"out_dir: {out_dir}")
    print(f"downloaded: {results_summary['totals']['downloaded']}")
    print(f"skipped: {results_summary['totals']['skipped']}")
    print(f"failed: {results_summary['totals']['failed']}")
    print(f"texts_extracted: {results_summary['totals']['texts_extracted']}")
    print(
        "index_hook: docs_txt={docs} chunks_estimated={chunks}".format(
            docs=index_hook.get("documents_txt", 0),
            chunks=index_hook.get("chunks_estimated", 0),
        )
    )
    print(f"source metadata: {paths['meta'] / 'sources.json'}")
    print(f"summary: {paths['meta'] / 'bootstrap_summary.json'}")
    print(f"log: {log_file}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Download and prepare starter India legal corpus for offline RAG citations.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """
            Examples:
              python scripts/bootstrap_legal_corpus.py --starter
              python scripts/bootstrap_legal_corpus.py --acts-only --max-acts 40
              python scripts/bootstrap_legal_corpus.py --sc-only --max-sc 500 --force
              python scripts/bootstrap_legal_corpus.py --dry-run
            """
        ),
    )
    p.add_argument("--config", default=str(Path(__file__).resolve().parent / "legal_corpus_sources.json"), help="Path to source config JSON")
    p.add_argument("--out-dir", default=str(Path(__file__).resolve().parents[1] / "legal_corpus"), help="Output corpus directory")
    p.add_argument("--starter", action="store_true", default=False, help="Download starter pack (default mode when no --*-only flag is used)")
    p.add_argument("--acts-only", action="store_true", help="Download only Acts source(s)")
    p.add_argument("--sc-only", action="store_true", help="Download only Supreme Court subset")
    p.add_argument("--hc-only", action="store_true", help="Download only High Court subset")
    p.add_argument("--max-acts", type=int, default=None, help="Maximum number of act files for starter")
    p.add_argument("--max-sc", type=int, default=2000, help="Maximum number of Supreme Court judgments for starter")
    p.add_argument("--max-hc", type=int, default=500, help="Maximum number of High Court judgments for starter")
    p.add_argument("--dry-run", action="store_true", help="Plan only, do not download/write files")
    p.add_argument("--force", action="store_true", help="Re-download even if files already exist")
    return p


if __name__ == "__main__":
    parser = build_parser()
    ns = parser.parse_args()
    raise SystemExit(run(ns))

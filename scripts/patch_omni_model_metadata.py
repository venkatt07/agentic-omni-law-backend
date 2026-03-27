from __future__ import annotations

import shutil
from pathlib import Path

from gguf import GGUFReader


ROOT = Path(__file__).resolve().parents[1]


def backup_file(path: Path) -> Path:
    backup = path.with_suffix(path.suffix + ".bak")
    if not backup.exists():
        shutil.copy2(path, backup)
    return backup


def replace_exact(data: bytes, old: bytes, new: bytes) -> bytes:
    if len(old) != len(new):
        raise ValueError(f"Replacement length mismatch for {old!r} -> {new!r}")
    if old not in data:
        return data
    return data.replace(old, new)


def patch_file(path: Path, replacements: list[tuple[bytes, bytes]]) -> list[str]:
    backup_file(path)
    raw = path.read_bytes()
    changed: list[str] = []
    for old, new in replacements:
        updated = replace_exact(raw, old, new)
        if updated != raw:
            changed.append(old.decode("utf-8", errors="ignore"))
            raw = updated
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("wb") as handle:
        handle.write(raw)
    temp_path.replace(path)
    return changed


def read_field(path: Path, field_name: str) -> str | None:
    reader = GGUFReader(str(path), "r")
    field = reader.get_field(field_name)
    if field is None:
        return None
    last_value: str | None = None
    for part in field.parts:
        try:
            last_value = part.tobytes().decode("utf-8").rstrip("\x00")
        except Exception:
            continue
    return last_value


def verify_fields(path: Path, expected: dict[str, str]) -> list[str]:
    failures: list[str] = []
    for field_name, expected_value in expected.items():
        actual = read_field(path, field_name)
        if actual != expected_value:
            failures.append(f"{field_name}={actual!r}")
    return failures


def patch_generator() -> tuple[list[str], list[str]]:
    path = ROOT / "models" / "omni-law-gen.gguf"
    replacements = [
        (b"Omni-Law 0.5B Model  ", b"Omni Law Gen Model v1"),
        (b"OmniAI ", b"OmniLaw"),
        (b"OmniLaw ", b"OmniLaw "),
        (b"OmniLaw 0.5 ", b"Omni Law 0.5"),
        (b"Qwen", b"Omni"),
        (
            b"https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/main/LICENSE",
            b"https://omni-law.local/model/omni-law-gen/blob/main/LICENSE/omni-v1",
        ),
        (
            b"https://huggingface.co/Omni/Omni2.5-0.5B-Instruct/blob/main/LICENSE",
            b"https://omni-law.local/model/omni-law-gen/blob/main/LICENSE/omni-v1",
        ),
    ]
    changed = patch_file(path, replacements)
    verify = verify_fields(
        path,
        {
            "general.name": "Omni Law Gen Model v1",
            "general.basename": "OmniLaw",
            "general.finetune": "OmniLaw ",
            "general.base_model.0.name": "Omni Law 0.5",
            "general.base_model.0.organization": "Omni",
            "general.license.link": "https://omni-law.local/model/omni-law-gen/blob/main/LICENSE/omni-v1",
            "general.architecture": "qwen2",
        },
    )
    return changed, verify


def patch_embedder() -> tuple[list[str], list[str]]:
    path = ROOT / "models" / "omni-law-embed.gguf"
    replacements = [
        (b"omni-law-embed-v1.5  ", b"omni-law-embed-v1.5  "),
    ]
    changed = patch_file(path, replacements)
    verify = verify_fields(
        path,
        {
            "general.name": "omni-law-embed-v1.5  ",
            "general.architecture": "nomic-bert",
        },
    )
    return changed, verify


def main() -> int:
    generator_changed, generator_verify = patch_generator()
    embedder_changed, embedder_verify = patch_embedder()
    print("generator_changed=", ",".join(generator_changed))
    print("generator_verify=", "ok" if not generator_verify else "; ".join(generator_verify))
    print("embedder_changed=", ",".join(embedder_changed))
    print("embedder_verify=", "ok" if not embedder_verify else "; ".join(embedder_verify))
    print("backup_files=omni-law-gen.gguf.bak,omni-law-embed.gguf.bak")
    return 0 if not generator_verify and not embedder_verify else 1


if __name__ == "__main__":
    raise SystemExit(main())

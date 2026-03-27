import json
import os
import sys

import fitz


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: render_pdf_pages.py <pdf_path> <out_dir> [max_pages]"}))
        return 1

    pdf_path = sys.argv[1]
    out_dir = sys.argv[2]
    max_pages = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    max_pages = max(1, min(max_pages, 5))

    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    images = []
    try:
        page_count = min(len(doc), max_pages)
        for index in range(page_count):
            page = doc.load_page(index)
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            out_path = os.path.join(out_dir, f"page-{index + 1}.png")
            pix.save(out_path)
            images.append(out_path)
    finally:
        doc.close()

    print(json.dumps({"images": images}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

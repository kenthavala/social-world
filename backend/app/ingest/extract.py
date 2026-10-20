"""Per-page extraction from PDF/TXT/MD/DOCX + scanned-PDF detection."""
from __future__ import annotations

import io
from pathlib import Path
from typing import Any

try:  # pymupdf >= 1.24 exposes both names
    import pymupdf as _fitz  # type: ignore
except ImportError:  # pragma: no cover
    import fitz as _fitz  # type: ignore

MIN_PAGE_CHARS = 20


def _docx_pages(data: bytes) -> list[dict[str, Any]]:
    from docx import Document
    doc = Document(io.BytesIO(data))
    text = "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
    return [{"page": 1, "text": text}]


def extract(data: bytes, filename: str, max_pages: int = 200) -> dict[str, Any]:
    """Returns {pages: [{page, text}], truncated: bool, empty: bool}."""
    suffix = Path(filename).suffix.lower()
    pages: list[dict[str, Any]] = []
    truncated = False
    if suffix == ".pdf":
        with _fitz.open(stream=data, filetype="pdf") as doc:
            total = doc.page_count
            use = min(total, max_pages)
            truncated = total > max_pages
            for i in range(use):
                text = doc[i].get_text("text") or ""
                pages.append({"page": i + 1, "text": text})
    elif suffix in (".txt", ".md"):
        pages = [{"page": 1, "text": data.decode("utf-8", errors="replace")}]
    elif suffix == ".docx":
        pages = _docx_pages(data)
    else:
        raise ValueError(f"unsupported file type '{suffix}' (use .pdf .txt .md .docx)")
    if truncated:
        pages = pages[:max_pages]
    return {"pages": pages, "truncated": truncated, "empty": not any(
        p["text"].strip() for p in pages)}


def scanned_check(pages: list[dict[str, Any]]) -> str | None:
    """Returns an error message if the document looks scanned, else None."""
    pdf_pages = [p for p in pages if len(p.get("text", "")) < MIN_PAGE_CHARS]
    if pages and len(pdf_pages) / len(pages) > 0.5:
        return ("This PDF looks scanned. OCR is not included in v1; "
                "export a text PDF or paste the text.")
    return None

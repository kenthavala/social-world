"""Ingestion tests: extraction, cleaning, chunking, BM25 index, scanned-PDF guard."""
from __future__ import annotations

import pytest

from app.api.sources import extract_text_document
from app.errors import AppError
from app.ingest import extract as extract_mod, clean as clean_mod, chunk as chunk_mod
from app.ingest.index import SourceIndex


BODY_PARAS = [
    ("Renewable energy subsidies encourage investment and reduce emissions, according to "
     "several analysts who reviewed the market data in recent years. The programme "
     "attracted manufacturers to regions that had lost traditional industry."),
    ("Critics counter that household costs rise when subsidies are funded through levies, "
     "and that grid operators struggle with intermittent supply during calm winter weeks "
     "when demand peaks and solar output is minimal across the region."),
    ("Rural towns remain split on wind projects. Some welcome the investment and jobs; "
     "others object to land use changes and the scale of turbines near primary schools."),
    ("The council must decide before the budget review scheduled for later this quarter, "
     "with consultations running across four districts and more than thirty submissions."),
]

HEADER = "Quarterly Policy Review 2026"
FOOTER = "Internal publication"


def make_pdf(pages: int, with_header=True, blank=False) -> bytes:
    import pymupdf as fitz
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page()
        if blank:
            continue
        rect = fitz.Rect(50, 40, 545, 700)
        text = ""
        if with_header:
            text += f"{HEADER}\n"
        text += "\n\n".join(BODY_PARAS) + f" (page {i + 1})\n"
        if with_header:
            text += f"\n{FOOTER}\n{i + 1}\n"
        page.insert_textbox(rect, text, fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


def test_pdf_pages_and_cleaning():
    data = make_pdf(5)
    extracted = extract_mod.extract(data, "report.pdf", max_pages=200)
    assert len(extracted["pages"]) == 5
    assert extract_mod.scanned_check(extracted["pages"]) is None
    cleaned = clean_mod.clean_pages(extracted["pages"])
    # repeated header/footer lines removed on all pages
    for p in cleaned:
        assert HEADER not in p["text"].splitlines()[0:1] or HEADER in p["text"]
    joined = "\n".join(p["text"] for p in cleaned)
    assert joined.count(HEADER) == 0 or len(cleaned) < 3
    assert FOOTER not in joined


def test_chunks_have_page_numbers_and_bounds():
    data = make_pdf(5)
    pages = clean_mod.clean_pages(extract_mod.extract(data, "x.pdf")["pages"])
    chunks = chunk_mod.chunk_pages(pages, "src_test")
    assert len(chunks) >= 2
    ids = {c["id"] for c in chunks}
    assert len(ids) == len(chunks)
    for c in chunks:
        assert c["id"].startswith("c_")
        assert 1 <= c["page_start"] <= c["page_end"] <= 5
        assert c["n_words"] >= 30
    # overlap: consecutive chunks share text (the kept last paragraph)
    if len(chunks) >= 2:
        first_words = " ".join(chunks[1]["text"].split()[:15])
        assert first_words in chunks[0]["text"]


def test_scanned_pdf_rejected(fresh_db):
    data = make_pdf(4, blank=True)
    with pytest.raises(AppError) as e:
        extract_text_document(data, "scan.pdf")
    assert "scanned" in e.value.message.lower()


def test_upload_pipeline_and_index(fresh_db):
    data = make_pdf(3)
    stats = extract_text_document(data, "policy.pdf")
    assert stats["status"] == "extracted"
    assert stats["pages"] == 3
    assert stats["chunks"] >= 1
    # dedupe returns the same source
    stats2 = extract_text_document(data, "policy.pdf")
    assert stats2["deduplicated"] is True
    assert stats2["source_id"] == stats["source_id"]
    # BM25 finds a chunk for a query
    idx = SourceIndex(stats["source_id"])
    assert idx.load()
    hits = idx.search("household costs rise", k=2)
    assert hits

"""Paragraph-merged chunks (250-400 words, 1-paragraph overlap, never across a heading)."""
from __future__ import annotations

import hashlib
import re
from typing import Any

HEADING_RE = re.compile(
    r"^[A-Z0-9][^.!?\n]{0,58}(?<![\w,])$"   # short line, no sentence punctuation
)


def is_heading(line: str) -> bool:
    line = line.strip()
    if not line or len(line) > 60 or len(line) < 3:
        return False
    if line.endswith((".", "?", "!", ",", ";", ":")):
        return False
    words = line.split()
    if len(words) > 10:
        return False
    # all words capitalised or line is Title Case-ish
    caps = sum(1 for w in words if w[0].isupper())
    return caps >= max(1, len(words) - 1)


def _paragraphs(text: str) -> list[str]:
    parts = re.split(r"\n\s*\n", text)
    return [re.sub(r"\s+", " ", p).strip() for p in parts if p.strip()]


def chunk_pages(pages: list[dict], source_id: str,
                min_words: int = 250, max_words: int = 400) -> list[dict]:
    """Build chunks with page_start/page_end/heading tracking."""
    # build document as (page_number, paragraph, heading) stream
    stream: list[tuple[int, str, str | None]] = []
    for p in pages:
        current_heading: str | None = None
        for line in p["text"].splitlines():
            if is_heading(line):
                current_heading = line.strip()
        paras = _paragraphs(p["text"])
        for para in paras:
            if stream and stream[-1][1] == para:
                continue
            stream.append((p["page"], para, current_heading))

    chunks: list[dict] = []
    buf: list[tuple[int, str, str | None]] = []
    heading: str | None = None

    def flush() -> None:
        nonlocal buf, heading
        if not buf:
            return
        words = sum(len(b[1].split()) for b in buf)
        if words < 30 and chunks:  # merge tiny tails into previous chunk
            prev = chunks[-1]
            prev["text"] = (prev["text"] + " " + " ".join(b[1] for b in buf)).strip()[:6000]
            prev["page_end"] = int(max(prev["page_end"], max(b[0] for b in buf)))
            buf, heading = [], None
            return
        text = " ".join(b[1] for b in buf)
        idx = len(chunks)
        cid = "c_" + hashlib.sha1(f"{source_id}|{idx}".encode()).hexdigest()[:8]
        chunks.append({
            "id": cid, "idx": idx, "text": text,
            "page_start": int(min(b[0] for b in buf)),
            "page_end": int(max(b[0] for b in buf)),
            "heading": next((b[2] for b in buf if b[2]), heading),
            "n_words": words,
        })
        buf, heading = [], None

    for item in stream:
        page, para, para_heading = item
        if para_heading is not None and para_heading != heading and buf:
            # a new heading while buffer non-empty: close it before crossing
            words = sum(len(b[1].split()) for b in buf)
            if words >= min_words * 0.6:
                flush()
                heading = para_heading
        if para_heading is not None and heading is None:
            heading = para_heading
        buf.append((page, para, para_heading if para_heading else heading))
        words = sum(len(b[1].split()) for b in buf)
        if words >= max_words:
            # keep last paragraph for 1-paragraph overlap
            last = buf[-1]
            flush()
            if heading is None:
                heading = last[2]
            buf = [last]
    flush()
    return chunks

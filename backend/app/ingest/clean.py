"""Text cleaning: repeated headers/footers, page numbers, hyphenation, NFKC."""
from __future__ import annotations

import re
import unicodedata
from collections import Counter

_PAGE_NUM_RE = re.compile(r"^\s*(?:page\s*)?\d{1,4}\s*(?:of\s*\d{1,4})?\s*$", re.IGNORECASE)


def _norm(line: str) -> str:
    return unicodedata.normalize("NFKC", line).strip()


def remove_repeats(pages: list[dict], threshold: float = 0.4) -> list[dict]:
    """Drop lines that appear (normalised) on more than `threshold` of pages, and lone page numbers."""
    if len(pages) < 3:
        cleaned = [{**p, "text": _clean_lines(p["text"], set())} for p in pages]
        return cleaned
    counts: Counter[str] = Counter()
    for p in pages:
        seen: set[str] = set()
        for raw in p["text"].splitlines():
            norm = _norm(raw)
            if norm and norm not in seen:
                seen.add(norm)
                counts[norm] += 1
    n = len(pages)
    banned = {line for line, c in counts.items() if c / n > threshold and len(line) <= 80}
    return [{**p, "text": _clean_lines(p["text"], banned)} for p in pages]


def _clean_lines(text: str, banned: set[str]) -> str:
    out: list[str] = []
    for raw in text.splitlines():
        line = _norm(raw)
        if not line:
            out.append("")
            continue
        if line in banned or _PAGE_NUM_RE.match(line):
            continue
        out.append(line)
    return "\n".join(out)


def dehyphenate(text: str) -> str:
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    return re.sub(r"(?<![.!?\n])\n(?![\n])", " ", text)  # join broken lines


def clean_pages(pages: list[dict]) -> list[dict]:
    pages = remove_repeats(pages)
    out = []
    for p in pages:
        txt = unicodedata.normalize("NFKC", p["text"])
        txt = dehyphenate(txt)
        txt = re.sub(r"[ \t]+", " ", txt)
        out.append({**p, "text": txt.strip()})
    return out

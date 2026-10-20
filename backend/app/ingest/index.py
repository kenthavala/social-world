"""BM25 keyword index over chunks; tokenised corpus persisted for instant reload."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from rank_bm25 import BM25Okapi

from app.config import DATA_DIR

INDEX_DIR = DATA_DIR / "index"

_STOP = set("""a an the and or but if while is are was were be been being this that these those
it its as at by for from in into of on to with without about over under not no nor so then than
they them their there here we our you your he she his her i me my what which who whom whose will
would can could should shall may might must do does did done have has had more most other some
such only own same too very just also up down out off again further once""".split())

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if t not in _STOP and len(t) > 1]


class SourceIndex:
    def __init__(self, source_id: str):
        self.source_id = source_id
        self.chunk_ids: list[str] = []
        self.tokens: list[list[str]] = []
        self._bm25: Optional[BM25Okapi] = None

    def build(self, chunk_ids: list[str], texts: list[str]) -> None:
        self.chunk_ids = list(chunk_ids)
        self.tokens = [tokenize(t) for t in texts]
        self._persist()
        self._rebuild()

    def load(self) -> bool:
        path = INDEX_DIR / f"{self.source_id}.json"
        if not path.exists():
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self.chunk_ids = data["chunk_ids"]
            self.tokens = data["tokens"]
        except Exception:
            return False
        self._rebuild()
        return True

    def _rebuild(self) -> None:
        if self.tokens:
            self._bm25 = BM25Okapi(self.tokens)
        else:
            self._bm25 = None

    def _persist(self) -> None:
        INDEX_DIR.mkdir(parents=True, exist_ok=True)
        path = INDEX_DIR / f"{self.source_id}.json"
        path.write_text(json.dumps({"chunk_ids": self.chunk_ids, "tokens": self.tokens}),
                        encoding="utf-8")

    def search(self, query: str, k: int = 5) -> list[tuple[str, float]]:
        """Top-k (chunk_id, score), best first."""
        if self._bm25 is None or not self.chunk_ids:
            return []
        q = tokenize(query)
        if not q:
            return []
        scores = self._bm25.get_scores(q)
        order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:k]
        # Filter exact zeros only; tiny corpora (N<=1 docs) can produce negative
        # BM25Okapi scores via epsilon-clamped IDF, and those are still matches.
        return [(self.chunk_ids[i], float(scores[i])) for i in order if scores[i] != 0]


_cache: dict[str, SourceIndex] = {}


def get_index(source_id: str) -> SourceIndex:
    if source_id not in _cache:
        idx = SourceIndex(source_id)
        idx.load()
        _cache[source_id] = idx
    return _cache[source_id]


def put_index(idx: SourceIndex) -> None:
    _cache[idx.source_id] = idx


def search(source_id: str, query: str, k: int = 5) -> list[tuple[str, float]]:
    return get_index(source_id).search(query, k)

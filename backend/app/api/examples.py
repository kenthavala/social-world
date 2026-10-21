"""Bundled sample world endpoints."""
from __future__ import annotations

from fastapi import APIRouter

from app.examples import import_sample, sample_info

router = APIRouter(prefix="/api")


@router.get("/examples/sample")
def get_sample() -> dict:
    return sample_info()


@router.post("/examples/sample")
def load_sample() -> dict:
    return import_sample()

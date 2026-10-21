"""Provider failure paths and the bundled sample assets."""
from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx

from app.config import config
from app.errors import AppError
from app.llm.gateway import Gateway


def _custom(monkeypatch, base: str):
    monkeypatch.setenv("LLM_PROVIDER", "custom")
    monkeypatch.setenv("LLM_BASE_URL", base)
    monkeypatch.setenv("LLM_WIRE_FORMAT", "openai_chat")
    monkeypatch.setenv("LLM_API_KEY", "sk-TESTONLY")
    monkeypatch.setenv("LLM_MODEL", "m-1")
    config.reload()


def _msg(text: str = "hi"):
    return [{"role": "user", "content": text}]


@respx.mock
@pytest.mark.asyncio
async def test_402_inside_200_body_is_not_retried(fresh_db, fast_gateway, monkeypatch):
    _custom(monkeypatch, "https://gw402.test/v1")
    route = respx.post("https://gw402.test/v1/chat/completions").mock(
        return_value=httpx.Response(200, json={
            "error": {"message": "Insufficient credits on this account"}}))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _msg(), no_cache=True)
    assert e.value.http_status == 402
    assert "credits" in (e.value.hint or "").lower()
    assert route.call_count == 1  # 402 is not retryable


@respx.mock
@pytest.mark.asyncio
async def test_503_retries_four_times_then_fails(fresh_db, fast_gateway, monkeypatch):
    _custom(monkeypatch, "https://gw503.test/v1")
    route = respx.post("https://gw503.test/v1/chat/completions").mock(
        return_value=httpx.Response(503, json={"error": "temporarily unavailable"}))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _msg(), no_cache=True)
    assert e.value.http_status == 503
    assert route.call_count == 4
    errs = fresh_db.query("SELECT status, http_status FROM llm_calls WHERE status='error'")
    assert len(errs) == 4 and all(r["http_status"] == 503 for r in errs)


@respx.mock
@pytest.mark.asyncio
async def test_timeout_retries_and_reports_plain_error(fresh_db, fast_gateway, monkeypatch):
    _custom(monkeypatch, "https://gwtimeout.test/v1")
    route = respx.post("https://gwtimeout.test/v1/chat/completions").mock(
        side_effect=httpx.ReadTimeout("read timed out"))
    with pytest.raises(AppError) as e:
        await fast_gateway.complete("test", _msg(), no_cache=True)
    assert route.call_count == 4
    assert ("connection error" in e.value.message.lower()
            or "provider call failed" in e.value.message.lower())


def test_engine_pauses_on_provider_credit_error():
    from app.sim import engine
    err = AppError("402 from provider: out of credits", http_status=402,
                   error_type="provider_failed")
    assert engine._should_pause(err) is True
    assert engine._should_pause(AppError("400 bad request", http_status=400)) is False


def test_sample_pdf_is_clean_ascii_text():
    import pymupdf
    path = Path(__file__).resolve().parents[2] / "examples" / "harbour-city-congestion-charge.pdf"
    assert path.exists(), "the bundled sample PDF must be present"
    doc = pymupdf.open(path)
    text = "".join(page.get_text() for page in doc)
    doc.close()
    assert "�" not in text
    assert "GBP 6" in text
    assert "Congestion Charge" in text


def test_bundled_sample_bundle_imports(fresh_db):
    from app.examples import SAMPLE_PATH, import_bundle
    import json
    if not SAMPLE_PATH.exists():
        pytest.skip("sample-run.json has not been built in this checkout")
    data = json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
    res = import_bundle(data)
    assert res["imported"] is True
    rid = data["run"]["id"]
    assert fresh_db.scalar("SELECT COUNT(*) FROM runs WHERE id=?", (rid,)) == 1
    assert (fresh_db.scalar("SELECT COUNT(*) FROM posts WHERE run_id=?", (rid,)) or 0) > 0
    again = import_bundle(data)
    assert again["imported"] is False

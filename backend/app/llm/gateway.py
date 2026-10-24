"""LLM gateway: the only code that talks to providers. No tools/response_format, ever."""
from __future__ import annotations

import asyncio
import hashlib
import json as _json
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import httpx
from pydantic import BaseModel, ValidationError

from app import db
from app.config import config, get_api_key, provider_key_env
from app.errors import AppError, BudgetExhausted, redact
from app.llm import adapters, mock
from app.llm.presets import Preset, get_preset
from app.llm.ratelimit import rate_limiter

TASKS = ("brief", "persona", "write", "reflect", "report", "essay", "test")
RETRYABLE_STATUS = {429, 500, 502, 503, 504, 529}
BACKOFF = [2.0, 6.0, 15.0]


@dataclass
class LLMResult:
    text: str = ""
    parsed: Any = None
    model: str = ""
    provider: str = ""
    task: str = ""
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    latency_ms: int = 0
    from_cache: bool = False
    attempts: int = 1
    reasoning_seen: bool = False
    error: Optional[str] = None
    warnings: list[str] = field(default_factory=list)


def _canonical(messages: list[dict]) -> str:
    return _json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _request_hash(provider: str, model: str, task: str, messages: list[dict]) -> str:
    raw = f"{provider}|{model}|{task}|{_canonical(messages)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _emit(run_id: Optional[str], kind: str, payload: dict) -> None:
    if not run_id:
        return
    try:
        from app.api.stream import emit
        emit(run_id, kind, payload)
    except Exception:
        pass


def _record(run_id, task, provider, model, rhash, req_json, response_text,
            parsed_ok, status, http_status, error, tokens_in, tokens_out, latency_ms):
    if status == "ok" and run_id:
        db.execute(
            "UPDATE runs SET llm_calls_used = COALESCE(llm_calls_used,0)+1, updated_at=? WHERE id=?",
            (_now(), run_id))
    db.execute(
        "INSERT INTO llm_calls(run_id, task, provider, model, request_hash, request_json,"
        " response_text, parsed_ok, status, http_status, error, tokens_in, tokens_out,"
        " latency_ms, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, task, provider or "", model or "", rhash, req_json, (response_text or "")[:20000],
         1 if parsed_ok else 0, status, http_status, redact(error or "")[:1000],
         tokens_in, tokens_out, latency_ms, _now()))


def _check_budget(run_id: Optional[str]) -> None:
    if not run_id:
        return
    row = db.query_one(
        "SELECT llm_calls_used, llm_reserved, config_json FROM runs WHERE id=?", (run_id,))
    if row is None:
        return
    cfg = db.uj(row["config_json"], {}) or {}
    limit = cfg.get("max_llm_calls")
    used = row["llm_calls_used"] or 0
    reserved = row["llm_reserved"] or 0
    if limit is not None and used + reserved >= int(limit):
        raise BudgetExhausted(f"run budget exhausted: {used}+{reserved}/{limit} LLM calls")


def _reserve_budget(run_id: Optional[str]) -> None:
    """Atomically reserve one call slot so concurrent write batches cannot overshoot."""
    if not run_id:
        return
    with db.tx() as conn:
        row = conn.execute(
            "SELECT llm_calls_used, llm_reserved, config_json FROM runs WHERE id=?",
            (run_id,)).fetchone()
        if row is None:
            return
        cfg = db.uj(row["config_json"], {}) or {}
        limit = cfg.get("max_llm_calls")
        used = row["llm_calls_used"] or 0
        reserved = row["llm_reserved"] or 0
        if limit is not None and used + reserved >= int(limit):
            raise BudgetExhausted(f"run budget reached: {used}+{reserved}/{limit} LLM calls")
        conn.execute("UPDATE runs SET llm_reserved=COALESCE(llm_reserved,0)+1 WHERE id=?",
                     (run_id,))


def _release_budget(run_id: Optional[str]) -> None:
    if not run_id:
        return
    db.execute("UPDATE runs SET llm_reserved=CASE WHEN COALESCE(llm_reserved,0)>0"
               " THEN llm_reserved-1 ELSE 0 END WHERE id=?", (run_id,))


def _hint_for(provider: str, status: Optional[int], error_text: str) -> str | None:
    key_env = provider_key_env(provider)
    if status == 402:
        return (f"402 from {provider}: the account is out of credits or over its quota. "
                "Top up the provider account, switch provider in Settings, or resume after a top-up. "
                "The run is paused; recorded posts are kept.")
    if status in (401, 403):
        if provider == "tokenharbor":
            return ("403 from Token Harbor: the key was rejected or free models are not enabled. "
                    "Enable free models in the Token Harbor dashboard, then retry.")
        if provider == "nvidia_nim":
            return (f"401 from NVIDIA NIM: the key in {key_env or 'NVIDIA_API_KEY'} was rejected. "
                    "Create a new key at build.nvidia.com.")
        if provider == "fcc":
            return ("Auth rejected by the fcc proxy: set FCC_API_KEY to the proxy auth token "
                    "from the fcc Admin UI.")
        return f"{status} from {provider}: the API key in {key_env or '.env'} was rejected. Check and re-save it."
    if status == 404:
        return (f"404 from {provider}: model or endpoint not found. Pick another model "
                "(a wrong wire format also shows up as 404).")
    if status == 410:
        return (f"410 from {provider}: the model or endpoint has been retired (Gone). "
                "Pick a model the provider still serves in Settings, then resume the run.")
    if "empty response" in error_text.lower():
        return (f"{provider} returned an empty response repeatedly. Check the model name and "
                "max-token setting, or switch provider; the run is paused and resumable.")
    if "timeout" in error_text.lower() or "timed out" in error_text.lower():
        return (f"{provider} timed out after the configured limit. Raise LLM_TIMEOUT_SECONDS, "
                "reduce writes per tick, or switch provider; completed rounds are kept.")
    if status == 429:
        return (f"429 from {provider}: rate/budget limit hit. The gateway retries automatically; "
                "reduce writes per tick or lower LLM_RPM if it keeps happening.")
    if isinstance(status, int) and status >= 500:
        return f"{status} from {provider}: provider server error; the gateway retries and then falls back."
    if provider == "fcc" and ("connect" in error_text.lower() or "refused" in error_text.lower()):
        return "Could not reach the fcc proxy: start the Free Claude Code proxy (fcc-server) and retry."
    return None


class Gateway:
    def __init__(self) -> None:
        self._wire_cache: dict[str, str] = {}  # (provider, model) -> working wire format

    def pick_model(self, task: str, provider_name: Optional[str] = None) -> str:
        if task in ("write", "reflect") and config.llm_model_fast:
            return config.llm_model_fast
        return config.llm_model

    # -- main entry ----------------------------------------------------------
    async def complete(self, task: str, messages: list[dict], *,
                       expect: type[BaseModel] | None = None,
                       run_id: Optional[str] = None,
                       no_cache: bool = False,
                       max_items: Optional[int] = None,
                       check_budget: bool = True) -> LLMResult:
        if task not in TASKS:
            raise AppError(f"unknown LLM task '{task}'", component="llm", stage="complete")
        if check_budget:
            _check_budget(run_id)

        provider_name = (config.llm_provider or "mock")
        model = self.pick_model(task)
        rhash = _request_hash(provider_name, model, task, messages)

        # replay mode: serve only from llm_calls
        if config.llm_replay and run_id:
            row = db.query_one(
                "SELECT * FROM llm_calls WHERE run_id=? AND task=? AND request_hash=?"
                " AND parsed_ok=1 AND status='ok' ORDER BY id LIMIT 1", (run_id, task, rhash))
            if row is None or not row["response_text"]:
                raise AppError("replay miss: no recorded successful call for this exact request",
                               component="llm", stage="replay", error_type="replay_miss",
                               hint="Run the simulation normally (with the provider) first, then enable replay.")
            ok, parsed = self._try_parse(row["response_text"], expect, max_items)
            if not ok:  # loud, never silently degrade a replayed run
                raise AppError("replay hit but the recorded response does not satisfy the expected schema",
                               component="llm", stage="replay", error_type="replay_invalid",
                               hint="The recorded response was unparseable for this task now; "
                                    "disable replay or re-record with the provider.")
            return LLMResult(text=row["response_text"], parsed=parsed, model=row["model"] or "",
                             provider=row["provider"] or "", task=task, from_cache=True)

        # cache
        if config.llm_cache and not no_cache:
            row = db.query_one(
                "SELECT response_text, model, provider, tokens_in, tokens_out FROM llm_calls"
                " WHERE request_hash=? AND parsed_ok=1 AND status='ok' ORDER BY id LIMIT 1",
                (rhash,))
            if row is not None and row["response_text"]:
                ok, parsed = self._try_parse(row["response_text"], expect, max_items)
                if ok:
                    return LLMResult(text=row["response_text"], parsed=parsed,
                                     model=row["model"] or "", provider=row["provider"] or "",
                                     task=task, from_cache=True,
                                     tokens_in=row["tokens_in"], tokens_out=row["tokens_out"])

        warning_cb: Callable[[str], None] = lambda msg: _emit(run_id, "warning", {"message": msg})
        if check_budget:
            _reserve_budget(run_id)
        try:
            return await self._call_provider(task, messages, expect=expect, run_id=run_id,
                                             rhash=rhash, max_items=max_items,
                                             warning_cb=warning_cb)
        finally:
            if check_budget:
                _release_budget(run_id)

    # -- one provider/model attempt chain --------------------------------------
    async def _call_provider(self, task, messages, *, expect, run_id, rhash,
                             max_items, warning_cb,
                             provider_override: Optional[str] = None,
                             model_override: Optional[str] = None,
                             allow_fallback: bool = True,
                             depth: int = 0) -> LLMResult:
        provider_name = provider_override
        model = model_override
        last_error: Optional[str] = None
        last_status: Optional[int] = None
        for attempt in range(1, 5):  # 1 initial call + up to 3 retries
            try:
                # essay/persona get their long-form budget inside _send; double_tokens
                # is reserved for the explicit retry after a truncated response
                text, meta = await self._send(task, messages, provider_name, model,
                                              double_tokens=False)
            except BudgetExhausted:
                raise
            except AppError as e:
                provider_name, model = e.provider or provider_name, e.model or model
                last_error = e.message
                last_status = e.http_status
                _record(run_id, task, provider_name, model, rhash, _canonical(messages)[:8000],
                        "", 0, "error", e.http_status, e.message, None, None, 0)
                if e.http_status not in RETRYABLE_STATUS:
                    raise
                delay = self._delay(e)
                _emit(run_id, "waiting", {"reason": f"{provider_name} returned {e.http_status}", "seconds": round(delay, 1)})
                await asyncio.sleep(delay)
                continue
            except (httpx.TimeoutException, httpx.TransportError, ConnectionError) as e:
                provider_name = provider_name or config.llm_provider
                last_error = f"connection error: {type(e).__name__}: {redact(str(e))[:200]}"
                _record(run_id, task, provider_name, model, rhash, _canonical(messages)[:8000],
                             "", 0, "error", None, last_error, None, None, 0)
                delay = BACKOFF[min(attempt - 1, len(BACKOFF) - 1)] * (0.7 + 0.6 * random.random())
                _emit(run_id, "waiting", {"reason": "connection problem", "seconds": round(delay, 1)})
                await asyncio.sleep(delay)
                continue

            provider_name = meta["provider"]
            model = meta["model"]

            # reasoning model spent all tokens on thinking: double max_tokens once
            if not text and meta["finish_reason"] == "length" and not meta["doubled"]:
                warning_cb(f"{model} returned empty text (finish=length); retrying with more tokens")
                text, meta = await self._send(task, messages, provider_name, model, double_tokens=True)
            if not text:
                last_error = "empty response from model"
                _record(run_id, task, provider_name, model, rhash, _canonical(messages)[:8000],
                             "", 0, "error", None, last_error, meta.get("tokens_in"),
                             meta.get("tokens_out"), meta["latency_ms"])
                moved = await self._maybe_fallback(task, messages, expect, run_id, rhash,
                                                   max_items, warning_cb, provider_name, model,
                                                   allow_fallback, depth)
                if moved is not None:
                    return moved
                continue

            ok, parsed = self._try_parse(text, expect, max_items)
            if ok:
                _record(run_id, task, provider_name, model, rhash, _canonical(messages)[:8000],
                             text, 1, "ok", None, None, meta["tokens_in"], meta["tokens_out"],
                             meta["latency_ms"])
                return LLMResult(text=text, parsed=parsed, model=model or "", provider=provider_name or "",
                                 task=task, tokens_in=meta["tokens_in"], tokens_out=meta["tokens_out"],
                                 latency_ms=meta["latency_ms"], attempts=attempt,
                                 reasoning_seen=meta["reasoning_seen"])

            # one repair retry with the validation error
            note = self._parse_note(text)
            _record(run_id, task, provider_name, model, rhash, _canonical(messages)[:8000],
                    text, 0, "parse_failed", None,
                    f"invalid JSON before repair ({note})",
                    meta.get("tokens_in"), meta.get("tokens_out"), meta.get("latency_ms", 0))
            repair_messages = messages + [{
                "role": "user",
                "content": f"Your previous output was invalid JSON ({note}). Return ONLY the corrected JSON, nothing else.",
            }]
            text2, meta2 = "", meta
            try:
                # If the first answer was cut off, the repair gets a larger budget
                # instead of repeating the same truncation.
                text2, meta2 = await self._send(
                    task, repair_messages, provider_name, model,
                    double_tokens=meta.get("finish_reason") == "length")
            except BudgetExhausted:
                raise
            except Exception:
                pass
            ok2, parsed2 = self._try_parse(text2, expect, max_items)
            _record(run_id, task, provider_name, model, rhash,
                         _canonical(repair_messages)[:8000], text2, 1 if ok2 else 0,
                         "ok" if ok2 else "parse_failed", None,
                         None if ok2 else "invalid JSON after repair",
                         meta2.get("tokens_in"), meta2.get("tokens_out"), meta2.get("latency_ms", 0))
            if ok2:
                return LLMResult(text=text2, parsed=parsed2, model=model or "",
                                 provider=provider_name or "", task=task,
                                 tokens_in=meta2.get("tokens_in"), tokens_out=meta2.get("tokens_out"),
                                 latency_ms=meta2.get("latency_ms", 0), attempts=attempt + 1,
                                 reasoning_seen=meta2.get("reasoning_seen", False))
            last_error = "model could not produce valid JSON after one repair attempt"
            moved = await self._maybe_fallback(task, messages, expect, run_id, rhash,
                                               max_items, warning_cb, provider_name, model,
                                               allow_fallback, depth)
            if moved is not None:
                return moved
            # Two invalid answers in a row are not a transient fault: stop instead of
            # spending the remaining retries on the same unparseable output.
            raise AppError(
                last_error, component="llm", stage="generate", provider=provider_name,
                model=model, error_type="provider_failed",
                hint="The model returned text that is not the requested JSON twice in a row. "
                     "Switch model or lower the temperature; the run is paused and resumable.")

        # Retries exhausted on this model: try the fallback chain before failing.
        moved = await self._maybe_fallback(task, messages, expect, run_id, rhash,
                                           max_items, warning_cb, provider_name, model,
                                           allow_fallback, depth)
        if moved is not None:
            return moved
        raise AppError(
            last_error or "provider call failed after retries",
            component="llm", stage="generate", provider=provider_name, model=model,
            http_status=last_status,
            error_type="provider_failed",
            hint=_hint_for(provider_name or "provider", last_status, last_error or ""))

    def _parse_note(self, text: str) -> str:
        from app.llm import parsing as P
        try:
            P.extract_json(text)
            return "wrong structure for the requested schema"
        except Exception as e:
            return str(e)[:200]

    def _delay(self, err: AppError) -> float:
        ra = getattr(err, "retry_after", None)
        if isinstance(ra, (int, float)) and ra > 0:
            return min(120.0, float(ra)) + random.random()
        status = err.http_status
        base = 2.0 if status == 429 else 6.0
        return base * (0.7 + 0.6 * random.random())

    # -- actual HTTP send --------------------------------------------------------
    async def _send(self, task, messages, provider_override, model_override,
                    double_tokens=False) -> tuple[str, dict]:
        preset = get_preset(provider_override or config.llm_provider)
        if preset is None:
            raise AppError("unknown provider preset", component="llm", stage="send")
        model = model_override or self.pick_model(task)
        if not model and preset.name != "mock":
            raise AppError(f"no model configured for provider '{preset.name}'",
                           component="llm", stage="send", error_type="missing_model",
                           provider=preset.name,
                           hint="Pick a model in Settings (fetch the model list there).")
        api_key = "mock" if preset.name == "mock" else (get_api_key(preset.name) or "")
        if preset.name != "mock" and preset.requires_key and not api_key:
            raise AppError(f"missing API key for provider '{preset.name}'",
                           component="llm", stage="send", error_type="missing_key",
                           provider=preset.name,
                           hint=f"Set {provider_key_env(preset.name)} in .env, or paste the key in Settings.")
        if not api_key:
            api_key = "local"  # local OpenAI-compatible servers ignore the bearer value

        wire = preset.wire_format
        base = preset.base_url
        if preset.name == "fcc":
            cfg_base = str(config.get("fcc_base_url") or "").strip() or preset.base_url
            base = cfg_base.rstrip("/")
            if not base.endswith("/v1"):
                base += "/v1"
        if preset.name == "custom":
            wire = (config.llm_wire_format or "openai_chat").strip().lower()
            base = (config.llm_base_url or "").strip()
            if not base:
                raise AppError("custom provider needs LLM_BASE_URL", component="llm", stage="send",
                               error_type="missing_config", provider="custom",
                               hint="Set LLM_BASE_URL in .env to the endpoint root (e.g. http://localhost:11434/v1).")
        if preset.name == "opencode_zen":
            wire = self._wire_cache.get(f"opencode_zen|{model}", wire)

        if preset.name == "mock":
            return mock.complete_mock(task, messages), {
                "provider": "mock", "model": "mock", "latency_ms": 0,
                "tokens_in": None, "tokens_out": None,
                "finish_reason": "stop", "reasoning_seen": False, "doubled": double_tokens,
            }

        rpm = config.llm_rpm or preset.default_rpm or 10
        if preset.name == "fcc":
            rpm = config.default_rpm_fcc
        await rate_limiter.acquire(preset.name, rpm, config.llm_concurrency)
        started = time.monotonic()
        # Task-specific output budget. Persona batches and the essay are long-form:
        # a 1200-token cap truncated valid JSON on verbose/reasoning models.
        base_mult = 2 if task in ("persona", "essay") else 1
        max_tokens = min(config.llm_max_tokens * base_mult * (2 if double_tokens else 1), 4000)
        try:
            resp = await self._http_call(preset, wire, base, model, messages, api_key, max_tokens)
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            # Zen wire learning: wrong-endpoint error -> try the other adapter once
            if preset.name == "opencode_zen" and status in (400, 404):
                other = "anthropic_messages" if wire == "openai_chat" else "openai_chat"
                try:
                    resp = await self._http_call(preset, other, base, model, messages, api_key,
                                                 max_tokens)
                    self._wire_cache[f"opencode_zen|{model}"] = other
                except httpx.HTTPStatusError:
                    raise self._status_error(preset, model, e)
            else:
                raise self._status_error(preset, model, e)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            if preset.name == "fcc":
                raise AppError(f"fcc proxy unreachable: {type(e).__name__}",
                               component="llm", stage="send", provider=preset.name, model=model,
                               http_status=None,
                               hint="Start the Free Claude Code proxy (fcc-server) and retry.")
            raise
        finally:
            rate_limiter.release(preset.name)

        if getattr(resp, "error_message", None):
            status = getattr(resp, "error_status", None) or 502
            raise AppError(
                f"{status} from {preset.name}: {redact(resp.error_message)}",
                component="llm", stage="send", provider=preset.name, model=model,
                http_status=status,
                hint=_hint_for(preset.name, status, str(resp.error_message)))
        latency_ms = int((time.monotonic() - started) * 1000)
        return resp.text, {
            "provider": preset.name, "model": resp.model or model,
            "latency_ms": latency_ms, "tokens_in": resp.tokens_in,
            "tokens_out": resp.tokens_out, "finish_reason": resp.finish_reason,
            "reasoning_seen": resp.reasoning_seen, "doubled": double_tokens,
        }

    def _status_error(self, preset: Preset, model: str, e: httpx.HTTPStatusError) -> AppError:
        status = e.response.status_code
        err = AppError(
            f"{status} from {preset.name}: {redact(e.response.text[:300])}",
            component="llm", stage="send", provider=preset.name, model=model,
            http_status=status, hint=_hint_for(preset.name, status, e.response.text[:300]))
        ra = e.response.headers.get("retry-after")
        try:
            err.retry_after = float(ra) if ra else None  # type: ignore[attr-defined]
        except ValueError:
            err.retry_after = None  # type: ignore[attr-defined]
        return err

    async def _http_call(self, preset: Preset, wire: str, base: str, model: str,
                         messages: list[dict], api_key: str, max_tokens: int):
        if wire == "openai_chat":
            return await adapters.openai_chat(
                base, model, messages, api_key=api_key,
                temperature=config.llm_temperature, max_tokens=max_tokens,
                timeout=config.llm_timeout_seconds, extra_headers=preset.extra_headers)
        if wire == "anthropic_messages":
            resp = await adapters.anthropic_messages(
                base, model, messages, api_key=api_key,
                temperature=config.llm_temperature,
                max_tokens=max_tokens,
                timeout=config.llm_timeout_seconds)
            return resp
        raise AppError(f"unknown wire format '{wire}'", component="llm", stage="send",
                       provider=preset.name)

    # -- fallback chain ----------------------------------------------------------
    async def _maybe_fallback(self, task, messages, expect, run_id, rhash, max_items,
                              warning_cb, current_provider, current_model,
                              allow_fallback: bool, depth: int):
        if not allow_fallback or depth >= 1:
            return None
        for fb_model in [m for m in config.llm_fallback_models if m and m != current_model]:
            try:
                warning_cb(f"falling back to model {fb_model}")
                _record(run_id, task, current_provider, fb_model, rhash, "", "",
                             0, "fallback", None, f"switching model to {fb_model}", None, None, 0)
                return await self._call_provider(task, messages, expect=expect, run_id=run_id,
                                                 rhash=rhash, max_items=max_items,
                                                 warning_cb=warning_cb,
                                                 provider_override=current_provider,
                                                 model_override=fb_model,
                                                 allow_fallback=False, depth=depth + 1)
            except BudgetExhausted:
                raise
            except AppError:
                continue
        fb_provider = config.llm_fallback_provider
        if fb_provider and fb_provider != current_provider:
            try:
                warning_cb(f"falling back to provider {fb_provider}")
                _record(run_id, task, fb_provider, config.llm_model, rhash, "", "",
                             0, "fallback", None, f"switching provider to {fb_provider}", None, None, 0)
                return await self._call_provider(task, messages, expect=expect, run_id=run_id,
                                                 rhash=rhash, max_items=max_items,
                                                 warning_cb=warning_cb,
                                                 provider_override=fb_provider,
                                                 allow_fallback=False, depth=depth + 1)
            except BudgetExhausted:
                raise
            except AppError:
                return None
        return None

    # -- validation ---------------------------------------------------------------
    def _try_parse(self, text: str, expect: type[BaseModel] | None, max_items: Optional[int]) -> tuple[bool, Any]:
        from app.llm import parsing as P
        try:
            data = P.extract_json(text)
        except Exception:
            return False, None
        if expect is None:
            return True, data
        try:
            if isinstance(data, list):
                if max_items is not None:
                    data = data[:max_items]
                out = []
                for item in data:
                    if not isinstance(item, dict):
                        return False, None
                    out.append(expect.model_validate(item))
                return True, out
            if isinstance(data, dict):
                return True, expect.model_validate(data)
            return False, None
        except ValidationError:
            return False, None

    # -- connection test -------------------------------------------------------------
    async def test_connection(self, provider_name: Optional[str] = None,
                              model: Optional[str] = None) -> dict:
        """Tiny live check. Returns a report dict (never contains the key)."""
        provider = (provider_name or config.llm_provider or "mock").strip().lower()
        report: dict[str, Any] = {"provider": provider, "model": "",
                                  "auth_ok": False, "model_ok": False, "json_ok": False,
                                  "reasoning_seen": False, "latency_ms": None, "error": None, "hint": None}
        if provider == "mock":
            report.update(auth_ok=True, model_ok=True, json_ok=True, model="mock",
                          latency_ms=0, hint="Mock provider always answers; switch provider for real calls.")
            return report
        preset = get_preset(provider)
        if preset is None:
            report.update(error="unknown provider", hint="Pick a known provider preset.")
            return report
        # auth + (optionally) model listing
        api_key = get_api_key(provider)
        if not api_key and preset.requires_key:
            report.update(error="missing key",
                          hint=f"Set {provider_key_env(provider)} in .env, or paste the key in Settings.")
            return report
        started = time.monotonic()
        try:
            ids = await adapters.list_models(preset.base_url, api_key or "local", timeout=20)
            report["model_ok"] = True
            listed = ids[:200]
            if model and listed and model not in listed:
                report["hint"] = f"Model '{model}' was not in the provider's /models list; the call may still work."
        except Exception as e:
            report["error"] = redact(str(e)[:300])
            report["hint"] = "Could not list models (some providers hide that route) — still trying a chat call."
        try:
            result = await self._call_provider(
                "test", [{"role": "user", "content": 'Return exactly this JSON: {"ok": true, "n": 7}'}],
                expect=None, run_id=None, rhash=_request_hash("__test__", model or provider, "test", []),
                max_items=None, warning_cb=lambda m: None,
                provider_override=provider, model_override=model,
                allow_fallback=False)
            report.update(
                auth_ok=True, model_ok=report["model_ok"] or bool(result.model),
                json_ok=(result.parsed == {"ok": True, "n": 7}),
                reasoning_seen=result.reasoning_seen,
                latency_ms=result.latency_ms or int((time.monotonic() - started) * 1000),
                model=result.model or report["model"])
            if not report["json_ok"]:
                report["hint"] = "The model responded but not with the exact JSON; parsing still repairs most cases."
        except (AppError, BudgetExhausted, Exception) as e:
            if isinstance(e, AppError):
                report.update(error=e.message, hint=e.hint)
                if e.http_status in (401, 403):
                    report["auth_ok"] = False
            else:
                report.update(error=redact(str(e)[:300]))
        return report


gateway = Gateway()

"""Settings API: public config (never returns keys) + key writes to .env."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from app.config import ENV_FILE, ROOT, config, get_api_key, provider_key_env
from app.errors import AppError
from app.llm.presets import PRESETS

router = APIRouter(prefix="/api")

_KEY_VARS = [p.key_env for p in PRESETS.values() if p.key_env]

PUBLIC_FIELDS = [
    "llm_provider", "llm_model", "llm_model_fast", "llm_base_url", "llm_wire_format",
    "llm_temperature", "llm_max_tokens", "llm_timeout_seconds", "llm_rpm",
    "llm_concurrency", "llm_fallback_models", "llm_fallback_provider", "llm_cache",
    "llm_replay", "max_upload_mb", "max_pages", "port",
]


class SettingsIn(BaseModel):
    settings: dict[str, object] = {}
    keys: dict[str, str] = {}


def _public_settings() -> dict:
    out = {}
    for f in PUBLIC_FIELDS:
        out[f] = config.get(f) if f not in ("llm_provider",) else config.llm_provider
    out["fcc_base_url"] = config.get("fcc_base_url", "http://127.0.0.1:8082/v1")
    out["keys"] = {}
    for name, preset in PRESETS.items():
        if preset.key_env:
            out["keys"][preset.key_env] = bool(get_api_key(name))
    # non-secret timestamps for keys written through Settings
    out["key_set_at"] = config.get("_key_set_at", {}) or {}
    return out


def _keys_present() -> dict[str, bool]:
    return {p.key_env: bool(get_api_key(n)) for n, p in PRESETS.items() if p.key_env}


@router.get("/settings")
def get_settings() -> dict:
    return {"settings": _public_settings(), "keys": _keys_present()}


@router.post("/settings/redact-preview")
def redact_preview(body: dict) -> dict:
    """Test the same redact() used on every user-visible error/log string.

    Additive endpoint: returns the transformed text plus the rule tokens.
    """
    from app.errors import REDACTIONS, redact

    text = str(body.get("text") if isinstance(body, dict) else "")[:2000]
    return {"redacted": redact(text), "rules": list(REDACTIONS)}


@router.put("/settings")
def put_settings(body: SettingsIn) -> dict:
    import json as _json
    from app.config import SETTINGS_FILE
    # non-key settings -> data/settings.json
    file_cfg: dict = {}
    try:
        if SETTINGS_FILE.exists():
            file_cfg = _json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        file_cfg = {}
    for key, value in body.settings.items():
        if key not in PUBLIC_FIELDS:
            continue
        file_cfg[key] = value
    try:
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(_json.dumps(file_cfg, indent=2), encoding="utf-8")
    except OSError as e:
        raise AppError(f"could not write settings file: {e}", component="api", stage="settings")
    # keys -> .env (+ environment for the running process)
    if body.keys:
        _write_keys_to_env(body.keys)
    config.reload()
    return {"settings": _public_settings(), "keys": _keys_present()}


def _write_keys_to_env(keys: dict[str, str]) -> None:
    lines: list[str] = []
    if ENV_FILE.exists():
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    for var, value in keys.items():
        if var not in _KEY_VARS or not value:
            continue
        os.environ[var] = value  # live process
        replaced = False
        for i, line in enumerate(lines):
            if line.strip().startswith(f"{var}="):
                lines[i] = f"{var}={value}"
                replaced = True
                break
        if not replaced:
            lines.append(f"{var}={value}")
    try:
        ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError as e:
        raise AppError(f"could not write .env: {e}", component="api", stage="settings")
    # record when each key was set (metadata only; never the key itself)
    import json as _json
    from datetime import datetime, timezone
    from app.config import SETTINGS_FILE
    try:
        meta = {}
        if SETTINGS_FILE.exists():
            meta = _json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        stamps = dict(meta.get("_key_set_at") or {})
        now = datetime.now(timezone.utc).isoformat()
        for var, value in keys.items():
            if var in _KEY_VARS and value:
                stamps[var] = now
        meta["_key_set_at"] = stamps
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(_json.dumps(meta, indent=2), encoding="utf-8")
    except OSError:
        pass  # the key write succeeded; metadata is best-effort

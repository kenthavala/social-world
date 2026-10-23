"""Configuration: .env + data/settings.json. JSON settings override env for non-key values."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = Path(os.environ.get("OASIS_DATA_DIR", ROOT / "data"))
ENV_FILE = ROOT / ".env"
SETTINGS_FILE = DATA_DIR / "settings.json"

_KEY_ENV_VARS = [
    "OPENROUTER_API_KEY", "OPENCODE_API_KEY", "NVIDIA_API_KEY",
    "KILOCODE_API_KEY", "FCC_API_KEY", "TOKENHARBOR_API_KEY", "LLM_API_KEY",
]

load_dotenv(ENV_FILE)

_DEFAULTS: dict[str, Any] = {
    "llm_provider": "mock",
    "llm_model": "",
    "llm_model_fast": "",
    "llm_base_url": "",
    "llm_wire_format": "",
    "llm_temperature": 0.8,
    "llm_max_tokens": 1200,
    "llm_timeout_seconds": 90,
    "llm_rpm": None,
    "llm_concurrency": 2,
    "llm_fallback_models": "",
    "llm_fallback_provider": "",
    "llm_cache": True,
    "llm_replay": False,
    "max_upload_mb": 50,
    "max_pages": 200,
    "port": 8000,
    "default_rpm_fcc": 20,
}


class Config:
    def __init__(self) -> None:
        self._file: dict[str, Any] = {}
        self.reload()

    def reload(self) -> None:
        """Read data/settings.json; an absent file resets to empty (env wins)."""
        self._file = {}
        try:
            if SETTINGS_FILE.exists():
                self._file = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except Exception:
            self._file = {}

    # -- resolved values ----------------------------------------------------
    def _pref(self, name: str) -> tuple[Any, bool]:
        """Returns (value, from_file) preferring data/settings.json."""
        if name in self._file:
            return self._file[name], True
        env_name = name.upper()
        raw = os.environ.get(env_name, "")
        if raw == "":
            return _DEFAULTS.get(name), False
        # typed coercion against defaults
        default = _DEFAULTS.get(name)
        if isinstance(default, int):
            try:
                return int(float(raw)), False
            except ValueError:
                return default, False
        if isinstance(default, bool):
            return raw.lower() in ("1", "true", "yes", "on"), False
        if isinstance(default, float):
            try:
                return float(raw), False
            except ValueError:
                return default, False
        if default is None and name.endswith(("rpm",)):
            try:
                return int(float(raw)), False
            except ValueError:
                return None, False
        return raw, False

    def get(self, name: str, fallback: Any = None) -> Any:
        val, _ = self._pref(name)
        return val if val not in (None, "") else fallback

    # convenience properties
    @property
    def llm_provider(self) -> str:
        return (self.get("llm_provider") or "mock").strip().lower()

    @property
    def llm_model(self) -> str:
        return (self.get("llm_model") or "").strip()

    @property
    def llm_model_fast(self) -> str:
        return (self.get("llm_model_fast") or "").strip()

    @property
    def llm_base_url(self) -> Optional[str]:
        v = (self.get("llm_base_url") or "").strip()
        return v or None

    @property
    def llm_wire_format(self) -> Optional[str]:
        v = (self.get("llm_wire_format") or "").strip()
        return v or None

    @property
    def llm_temperature(self) -> float:
        return float(self.get("llm_temperature", 0.8))

    @property
    def llm_max_tokens(self) -> int:
        return int(self.get("llm_max_tokens", 1200))

    @property
    def llm_timeout_seconds(self) -> int:
        return int(self.get("llm_timeout_seconds", 90))

    @property
    def llm_rpm(self) -> Optional[int]:
        v = self.get("llm_rpm", None)
        try:
            return int(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    @property
    def llm_concurrency(self) -> int:
        return int(self.get("llm_concurrency", 2))

    @property
    def llm_fallback_models(self) -> list[str]:
        raw = self.get("llm_fallback_models", "")
        return [m.strip() for m in str(raw).split(",") if m.strip()]

    @property
    def llm_fallback_provider(self) -> Optional[str]:
        v = (self.get("llm_fallback_provider") or "").strip()
        return v or None

    @property
    def llm_cache(self) -> bool:
        return bool(self.get("llm_cache", True))

    @property
    def llm_replay(self) -> bool:
        return bool(self.get("llm_replay", False))

    @property
    def max_upload_mb(self) -> int:
        return int(self.get("max_upload_mb", 50))

    @property
    def max_pages(self) -> int:
        return int(self.get("max_pages", 200))

    @property
    def port(self) -> int:
        return int(self.get("port", 8000))

    @property
    def default_rpm_fcc(self) -> int:
        return int(self.get("default_rpm_fcc", 20))


config = Config()


def get_api_key(provider: str) -> Optional[str]:
    env_name = provider_key_env(provider)
    if not env_name:
        return None
    raw = os.environ.get(env_name, "")
    raw = raw.strip()
    if raw != "":
        return raw
    # keys may also be stored in settings.json (never returned to browser)
    k, _ = config._pref(env_name.lower())
    if isinstance(k, str) and k.strip():
        return k.strip()
    return None


def provider_key_env(provider: str) -> Optional[str]:
    from app.llm.presets import PRESETS
    preset = PRESETS.get(provider)
    return preset.key_env if preset else None

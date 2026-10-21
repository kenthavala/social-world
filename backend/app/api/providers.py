"""Provider info, model listing, connection test."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from app.config import config, get_api_key, provider_key_env
from app.errors import AppError
from app.llm import adapters
from app.llm.gateway import gateway
from app.llm.presets import PRESETS

router = APIRouter(prefix="/api")


@router.get("/providers")
def list_providers() -> dict:
    out = []
    for name, p in PRESETS.items():
        listed = p.base_url and p.name != "custom"
        out.append({
            "name": name,
            "wire_format": p.wire_format,
            "base_url": p.base_url if p.name != "custom" else "",
            "key_env": p.key_env,
            "has_key": bool(get_api_key(name)) if p.key_env else True,
            "requires_key": p.requires_key,
            "default_rpm": p.default_rpm or config.default_rpm_fcc if p.name == "fcc" else p.default_rpm,
            "notes": p.notes,
            "supports_model_list": bool(listed),
        })
    return {"providers": out}


@router.get("/providers/{name}/models")
async def provider_models(name: str) -> dict:
    preset = PRESETS.get(name)
    if name == "custom":
        base = config.llm_base_url
        if not base:
            raise AppError("custom provider needs LLM_BASE_URL", component="api",
                           stage="models", hint="Set LLM_BASE_URL in .env or Settings.")
        key_env = "LLM_API_KEY"
    elif preset is None:
        raise AppError(f"unknown provider '{name}'", component="api", stage="models", status_code=404)
    else:
        base = preset.base_url
        key_env = preset.key_env
    api_key = get_api_key(name)
    requires_key = preset.requires_key if preset is not None else True
    if not api_key and name != "mock" and requires_key:
        raise AppError(f"no key configured for {name}", component="api", stage="models",
                       error_type="missing_key",
                       hint=f"Set {key_env} in .env, or paste the key in Settings.")
    try:
        ids = await adapters.list_models(base, api_key or "local", timeout=25)
    except Exception as e:
        raise AppError(f"could not list models from {name}: {type(e).__name__}",
                       component="api", stage="models", provider=name,
                       hint="Model listing may be blocked for this provider; type a model name manually.")
    return {"provider": name, "models": ids,
            "free_only": [m for m in ids if "free" in m.lower() or m.endswith(":free")]}


class TestIn(BaseModel):
    provider: Optional[str] = None
    model: Optional[str] = None


@router.post("/providers/test")
async def test_provider(body: TestIn) -> dict:
    return await gateway.test_connection(body.provider, body.model)

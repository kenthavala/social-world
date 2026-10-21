"""FastAPI app: routers, AppError handler, startup recovery, static frontend."""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import db
from app.api import providers, runs, settings, sources, export
from app.errors import AppError, redact
from app.logsafe import install as install_redaction
from app.sim import engine
from app.version import APP_VERSION, PRODUCT_NAME

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logging.getLogger("sse_starlette").setLevel(logging.WARNING)
install_redaction()

app = FastAPI(title=PRODUCT_NAME, version=APP_VERSION)

app.include_router(sources.router)
app.include_router(runs.router)
app.include_router(providers.router)
app.include_router(settings.router)
app.include_router(export.router)


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.to_dict())


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, exc: Exception) -> JSONResponse:
    from fastapi import HTTPException
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code, content={
            "error": {"component": "http", "stage": str(request.url.path),
                      "error_type": "http_error", "http_status": exc.status_code,
                      "message": redact(str(exc.detail)),
                      "hint": "This is an HTTP-level error from the request itself.",
                      "request_id": ""}})
    # best-effort component/stage from the path
    parts = [p for p in str(request.url.path).split("/") if p][:3]
    err = AppError(f"Unexpected server error: {type(exc).__name__}",
                   component="api", stage="/".join(parts) or "request",
                   error_type="internal", hint="Check the server log for details.",
                   status_code=500)
    return JSONResponse(status_code=500, content=err.to_dict())


@app.on_event("startup")
def startup() -> None:
    db.connect()
    engine.recover_on_startup()
    try:
        from app.examples import ensure_sample_world
        ensure_sample_world()
    except Exception:  # noqa: BLE001 — the sample world must never block startup
        import logging
        logging.getLogger("app.main").warning("sample world import failed", exc_info=True)


@app.get("/api/health")
def health() -> dict:
    from app.config import config
    return {"ok": True, "provider": config.llm_provider, "db": str(db.DB_PATH.name)}


FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="ui")
else:
    @app.get("/")
    def ui_missing() -> dict:
        return {"message": "Frontend not built yet. Run start.bat (it builds frontend/dist).",
                "api_docs": "/docs"}

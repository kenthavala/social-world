"""Structured application errors. Every error is an AppError with context + hint."""
from __future__ import annotations

import uuid
from typing import Any, Optional

REDACTIONS = ("sk-", "nvapi-", "Bearer ", "eyJ")


def redact(text: Any) -> str:
    s = str(text) if text is not None else ""
    for token in REDACTIONS:
        idx = s.find(token)
        if idx >= 0:
            # mask from the token start to the next whitespace or 32 chars
            end = idx
            while end < len(s) and not s[end].isspace():
                end += 1
            s = s[:idx] + token + "[REDACTED]" + s[end:]
    return s


class AppError(Exception):
    def __init__(
        self,
        message: str,
        *,
        component: str = "app",
        stage: str = "unknown",
        error_type: str = "app_error",
        provider: Optional[str] = None,
        model: Optional[str] = None,
        http_status: Optional[int] = None,
        hint: Optional[str] = None,
        status_code: int = 400,
    ):
        self.message = redact(message)
        self.component = component
        self.stage = stage
        self.error_type = error_type
        self.provider = provider
        self.model = model
        self.http_status = http_status
        self.hint = hint
        self.status_code = status_code
        self.request_id = uuid.uuid4().hex[:12]
        super().__init__(self.message)

    def to_dict(self) -> dict:
        return {
            "error": {
                "component": self.component,
                "stage": self.stage,
                "error_type": self.error_type,
                "provider": self.provider,
                "model": self.model,
                "http_status": self.http_status,
                "message": self.message,
                "hint": self.hint,
                "request_id": self.request_id,
            }
        }


class BudgetExhausted(Exception):
    """Raised by the gateway when a run's LLM call budget is spent."""

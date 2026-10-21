"""Log redaction: mask API keys and authorization headers before they reach a handler.

The app already redacts every user-visible error string. This filter closes the
other path: a provider exception embedded in a traceback or an access log line.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from app.errors import redact

# Key-shaped values that do not contain one of the redact() prefixes.
_LONG_SECRET = re.compile(r"(?i)\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*[^\s,;\"']{8,}")
_BEARER = re.compile(r"(?i)(authorization\s*[:=]\s*bearer)\s+[^\s,;\"']+")
_SK = re.compile(r"\b(?:sk|nvapi|gsk|xai|pplx)-[A-Za-z0-9_\-]{8,}")


def scrub(text: Any) -> str:
    s = redact(text)
    s = _BEARER.sub(r"\1 [REDACTED]", s)
    s = _SK.sub("[REDACTED]", s)
    s = _LONG_SECRET.sub(lambda m: f"{m.group(1)}=[REDACTED]", s)
    return s


class RedactFilter(logging.Filter):
    """Rewrite record.msg/args so no handler can emit an unredacted secret."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
            cleaned = scrub(message)
            if cleaned != message:
                record.msg = cleaned
                record.args = ()
        except Exception:  # noqa: BLE001 — a logging filter must never break logging
            record.msg = "[log message could not be formatted]"
            record.args = ()
        return True


def install() -> None:
    """Attach the filter to the root logger and the loggers uvicorn uses."""
    f = RedactFilter()
    for name in ("", "uvicorn", "uvicorn.error", "uvicorn.access", "httpx"):
        logger = logging.getLogger(name)
        if not any(isinstance(x, RedactFilter) for x in logger.filters):
            logger.addFilter(f)
        for handler in logger.handlers:
            if not any(isinstance(x, RedactFilter) for x in handler.filters):
                handler.addFilter(f)

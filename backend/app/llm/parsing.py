"""Tolerant JSON extraction from LLM text: think blocks, fences, prose, commas."""
from __future__ import annotations

import json
import re
from typing import Any

OPEN_MARK = '<think>'
CLOSE_MARK = '</think>'
_THINK_RE = re.compile(re.escape(OPEN_MARK) + r".*?(" + re.escape(CLOSE_MARK) + r"|$)", re.DOTALL | re.IGNORECASE)
_FENCE_RE = re.compile(r"```[a-zA-Z0-9]*\s*(.*?)```", re.DOTALL)
OPEN_CURLIES = '“‘'
ALL_CURLIES = '“”‘’'



def _strip_think(text: str) -> str:
    if OPEN_MARK not in text:
        return text
    if CLOSE_MARK not in text:
        # Unclosed think block: the model never closed it; drop only the opener.
        return text.replace(OPEN_MARK, "")
    body = _THINK_RE.sub("", text)
    if OPEN_MARK in body:
        # A trailing unclosed opener after a closed block: cut the junk tail.
        body = body.split(OPEN_MARK)[0]
    return body


def _strip_fences(text: str) -> str:
    match = _FENCE_RE.search(text)
    if match and (match.group(1).strip().startswith("{") or match.group(1).strip().startswith("[")):
        return match.group(1)
    clean = text.replace("```json", "").replace("```", "")
    return clean


def _outermost_json(text: str) -> str | None:
    """Extract the outermost balanced JSON object or array, respecting strings."""
    start = None
    opener, closer = "", ""
    for i, ch in enumerate(text):
        if ch in "{[":
            start, opener, closer = i, ch, "}" if ch == "{" else "]"
            break
    if start is None:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


_TRAILING_COMMA_RE = re.compile(r",\s*([}\]])")


def _fix_common(text: str) -> str:
    """Normalize curly quotes to ASCII and drop trailing commas.

    Curly quotes are converted position-independently: an opening curly at a
    non-string position opens a JSON string; the matching closing curly closes
    it. Curly quotes that are already inside an ASCII-quoted string are left
    as literal content.
    """
    out = []
    in_string = False
    opened = ""  # the character that opened the current string
    escape = False
    for ch in text:
        if in_string:
            if escape:
                escape = False
                out.append(ch)
                continue
            if opened == '"' and ch == "\\":
                escape = True
                out.append(ch)
                continue
            if ch == opened:
                # Exact closer: ASCII quote or the same curly kind.
                in_string = False
                opened = ""
                out.append('"')
                continue
            if opened != '"' and ch in ALL_CURLIES:
                # Mismatched curly closer for a curly-opened string.
                in_string = False
                opened = ""
                out.append('"')
                continue
            if opened == '"' and ch in ALL_CURLIES:
                # Decorative curly quotes inside a plain string: drop them.
                continue
            out.append(ch)
            continue
        if ch == '"':
            in_string = True
            opened = '"'
            out.append('"')
            continue
        if ch in ALL_CURLIES:
            in_string = True
            opened = ch
            out.append('"')
            continue
        out.append(ch)
    return _TRAILING_COMMA_RE.sub("\\1", "".join(out))


def extract_json(text: str) -> Any:
    """Best-effort extraction of a JSON value from raw model output. Raises on failure."""
    if not text:
        raise ValueError("empty response")
    body = _strip_think(text)
    body = _strip_fences(body)
    candidate = _outermost_json(body)
    if candidate is None:
        candidate = body.strip()
        if not candidate:
            raise ValueError("no JSON found")
    for attempt in (_fix_common(candidate), candidate):
        try:
            return json.loads(attempt)
        except (json.JSONDecodeError, ValueError):
            continue
    raise ValueError("response is not valid JSON")

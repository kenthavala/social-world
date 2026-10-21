# Security

## Reporting

Once the repository is public, report vulnerabilities through GitHub Security Advisories
(“Report a vulnerability”) rather than a public issue. Do not include API keys, tokens or
personal data in a report. This project is local-first and has no hosted service.

## Secrets

- Keys are read from `.env` (git-ignored) or written through Settings; the API never
  returns a key, only booleans and non-secret timestamps.
- `.env`, `data/`, uploads and exports are git-ignored. Never commit a key or a database.
- A logging filter (`backend/app/logsafe.py`) redacts `Authorization: Bearer …`,
  `sk-…`, `nvapi-…`, `eyJ…`, `api_key=…`, `token=…` and similar shapes before handlers
  see them. Error strings use `redact()` as well.
- Exports omit keys and base URLs; they contain provider/model names and the manifest.

## Scope and posture

- The app binds to `127.0.0.1` by default. Do not expose it to the internet without adding
  authentication and TLS in front of it.
- Provider calls are the only outbound network requests. There is no telemetry.
- Uploaded documents are untrusted input: PDF/DOCX parsers run locally; scanned PDFs are
  rejected instead of OCRed. Files are stored under `data/uploads/<source_id>/`.
- The simulation writes only to the local SQLite database and `data/`.

## Known non-goals

- Multi-user accounts, roles or tenant isolation.
- Sandboxing of the LLM provider itself.
- Encryption at rest (the local SQLite file is plaintext).

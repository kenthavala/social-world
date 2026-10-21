# Contributing

## Setup

```bash
python3 -m venv .venv
. .venv/bin/activate && pip install -r backend/requirements.txt
cd frontend && npm ci && npm run build && cd ..
.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

On Windows, `start.bat` does the same and opens the app. No API key is needed for tests or
the sample world.

## Tests

```bash
.venv/Scripts/python.exe -m pytest backend/tests
cd frontend && npm run build
```

Tests use an isolated temporary database and force the deterministic mock provider. Never
commit a real key; tests contain only synthetic key-shaped strings for redaction checks.

## Honesty rules

- Never fabricate counts, citations, provider limits, status, health, timing or model
  output. Unknown values read “Not recorded”.
- Counted findings must link to the records behind them and show a denominator.
- Generated prose gets the dashed Generated treatment and names its model.
- Mock runs must stay striped in the UI and watermarked in exports.
- A comparison that is not linked as original/intervention must say so.

## Adding a provider preset

Add a `Preset` row in `backend/app/llm/presets.py` (wire format, base URL, key env, default
RPM, notes, whether a key is required). Add a provider cap in `app/sim/budget.py` only if
the allowance is known. The UI and Settings model list read the preset table. Add a
gateway test for any provider-specific quirk (body-level error, single system message,
non-standard wire format).

## UI conventions

- Semantic tokens only (`frontend/src/tokens.css`); no raw hex in components.
- Status is a dot/check plus a sentence-case label, never colour alone.
- Stance always has shape + label (circle/square/diamond).
- Use sentence-case Sans labels; mono only for ids, rounds, numbers and model names.
- Run-details, source and intervention surfaces are focus-trapped drawers; Esc closes.

## Commits

Small, logical commits with a clear subject. Run the backend suite and frontend build
before each. Do not commit `.env`, `data/`, generated exports, or secrets.

## Sample world

Regenerate the fictional source and bundle with:

```bash
.venv/Scripts/python.exe tools/make_sample_pdf.py
.venv/Scripts/python.exe tools/make_sample_run.py
```

`--mock` builds a clearly labelled mock sample; `--resume <run_id>` resumes a real run;
`--export <run_id>` rewrites `examples/sample-run.json` from an existing run.

@echo off
REM E2E server launcher: fresh backend (uvicorn :8000) + frontend (vite :5173)
REM Uses a temporary data dir so the user's data/oasis.db is never touched, and
REM CLEARS it first: the suite's conditions (DoD) are defined on a blank dir, and
REM a source carried over from a previous session takes a different wizard path.
cd /d "%~dp0"

REM The clear below is a recursive delete, so it is hard-scoped: the resolved path
REM must be exactly <TEMP>\oasis-e2e-data. Anything else (unset TEMP, a stray
REM separator, a redefined E2E_DATA) aborts instead of deleting.
set "E2E_DATA=%TEMP%\oasis-e2e-data"
powershell -NoProfile -Command "$e=$env:E2E_DATA; $t=$env:TEMP; if (-not $e -or -not $t) { Write-Host 'refusing to clear: TEMP or E2E_DATA is empty'; exit 2 }; $p=[IO.Path]::GetFullPath($e); $root=[IO.Path]::GetFullPath($t).TrimEnd('\'); $want=$root + '\oasis-e2e-data'; if ($p -ne $want) { Write-Host ('refusing to clear unexpected path: ' + $p); exit 2 }; if ($p.Length -lt ($root.Length + 15)) { Write-Host 'refusing to clear: path too short'; exit 2 }"
if errorlevel 1 (
  echo [start-e2e] ABORT: the E2E data dir failed its path guard. Nothing was deleted.
  exit /b 1
)
if exist "%E2E_DATA%" rd /s /q "%E2E_DATA%"
if exist "%E2E_DATA%" (
  echo [start-e2e] ABORT: could not clear "%E2E_DATA%".
  echo [start-e2e] A backend or another process is probably holding the SQLite file.
  echo [start-e2e] Stop it and retry; running on stale data would break the DoD preconditions.
  exit /b 1
)
if not exist "%E2E_DATA%" mkdir "%E2E_DATA%"
if not exist "%E2E_DATA%" (
  echo [start-e2e] ABORT: could not create "%E2E_DATA%".
  exit /b 1
)
set OASIS_DATA_DIR=%E2E_DATA%

REM Pin the provider to mock inside the run data dir. data/settings.json outranks
REM LLM_PROVIDER, so a provider saved by an earlier (manual) session would otherwise
REM leak into the suite: real keys, real 401s and runs that pause instead of passing.
REM Written with char 34 so the command line needs no nested quotes; UTF-8 without BOM.
powershell -NoProfile -Command "$q=[char]34; $p=Join-Path $env:OASIS_DATA_DIR 'settings.json'; [IO.File]::WriteAllText($p, '{'+$q+'llm_provider'+$q+':'+$q+'mock'+$q+'}')"
if errorlevel 1 (
  echo [start-e2e] ABORT: could not pin the provider to mock in "%E2E_DATA%".
  exit /b 1
)

REM Backend on 127.0.0.1:8000 with a clean temp data dir
cd backend
start "TSW-backend" /B ..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
cd ..
:wait_health
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:8000/api/health' -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  ping -n 3 127.0.0.1 >nul
  goto wait_health
)

REM Frontend on 5173 (foreground — Playwright waits for http://localhost:5173)
cd frontend
npm run dev

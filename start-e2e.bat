@echo off
REM E2E server launcher: fresh backend (uvicorn :8000) + frontend (vite :5173)
REM Uses a temporary data dir so the user's data/oasis.db is never touched.
cd /d "%~dp0"

set E2E_DATA=%TEMP%\oasis-e2e-data
if not exist "%E2E_DATA%" mkdir "%E2E_DATA%"
set OASIS_DATA_DIR=%E2E_DATA%

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

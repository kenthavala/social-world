@echo off
REM OASIS-Lite launcher: prepares the venv + frontend on first run, then serves
REM everything (app + UI) from one port: http://127.0.0.1:8000
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [OASIS-Lite] Creating Python venv...
  py -3.11 -m venv .venv || python -m venv .venv
  if errorlevel 1 (
    echo [OASIS-Lite] Python 3.11/3.12 not found. Install it from python.org and retry.
    pause & exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --upgrade pip -q
  ".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt -q
)

if not exist "frontend\dist\index.html" (
  echo [OASIS-Lite] Building the frontend bundle...
  pushd frontend
  if not exist "node_modules" call npm install --no-audit --no-fund
  call npm run build
  popd
)

echo [OASIS-Lite] Starting server on http://127.0.0.1:8000 ...
start "" http://127.0.0.1:8000
pushd backend
".venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
popd
pause

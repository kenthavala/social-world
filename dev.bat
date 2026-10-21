@echo off
REM Dev mode: backend with auto-reload (API docs at /docs) + Vite dev server with
REM fast-refresh UI on http://127.0.0.1:5173 (proxies /api to :8000).
setlocal
cd /d "%~dp0"

start "The Social World backend" cmd /c "pushd backend && ..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload && popd"
start "The Social World frontend" cmd /c "pushd frontend && npm run dev && popd"

echo Backend:  http://127.0.0.1:8000/docs
echo Frontend: http://127.0.0.1:5173
echo Close the opened windows to stop.
pause

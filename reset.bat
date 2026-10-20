@echo off
REM Hard reset: deletes the local database, uploaded documents, BM25 index and
REM settings (does NOT touch the venv, node_modules or the root .env API keys).
setlocal
cd /d "%~dp0"

echo This deletes data (SQLite DB, uploaded documents, BM25 index, settings.json).
set /p CONF=Type YES to continue:
if /i not "%CONF%"=="YES" (
  echo Aborted.
  pause & exit /b 0
)

rmdir /s /q data 2>nul
echo Cleared data. Server will re-create it on next start.
pause

@echo off
setlocal
cd /d "%~dp0"
set "LOCAL_NODE=node"
where node >nul 2>&1
if errorlevel 1 set "LOCAL_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%LOCAL_NODE%" tools\start-local.mjs
if errorlevel 1 (
  echo Startup failed. See the message above.
  pause
  exit /b 1
)
pause

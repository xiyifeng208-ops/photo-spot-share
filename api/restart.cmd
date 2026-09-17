@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "API_DIR=%~dp0"
set "NODE_EXE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE_EXE=C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

echo [1/3] 查找占用 3000 端口的进程...
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  echo     结束进程 %%a
  taskkill /F /PID %%a >nul 2>&1
  if errorlevel 1 echo     权限不足，请改用管理员身份运行本脚本
)
if not defined FOUND echo     没有占用 3000 的进程，直接启动

timeout /t 1 >nul

echo [2/3] 进入 %API_DIR%
cd /d "%API_DIR%"

echo [3/3] 启动后端，这个窗口不要关（Ctrl+C 停止）
echo     健康检查：http://localhost:3000/health
"%NODE_EXE%" dist\main.js

echo.
echo 后端已退出，按任意键关闭窗口。
pause

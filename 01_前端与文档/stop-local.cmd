@echo off
chcp 65001 >nul
setlocal

set "PROJECT_ROOT=%~dp0"
set "PG_BIN=%PROJECT_ROOT%.local\postgres\pgsql\bin"
set "PG_DATA=%PROJECT_ROOT%.local\pgdata"

if not exist "%PG_BIN%\pg_ctl.exe" (
  echo 未找到便携 PostgreSQL；无需停止。
  exit /b 0
)

"%PG_BIN%\pg_ctl.exe" status -D "%PG_DATA%" >nul 2>&1
if errorlevel 1 (
  echo 本项目的 PostgreSQL 当前没有运行；不会操作其他进程。
  exit /b 0
)

echo 正在安全停止 PostgreSQL...
"%PG_BIN%\pg_ctl.exe" -D "%PG_DATA%" -w stop -m fast
if errorlevel 1 (
  echo 停止失败，请检查是否有其他 PostgreSQL 进程占用 55432 端口。
  pause
  exit /b 1
)
echo PostgreSQL 已停止。

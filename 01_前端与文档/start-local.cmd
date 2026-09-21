@echo off
chcp 65001 >nul
setlocal

set "PROJECT_ROOT=%~dp0"
set "LOCAL_ROOT=%PROJECT_ROOT%.local"
set "NODE_DIR=%LOCAL_ROOT%\node"
set "PG_BIN=%LOCAL_ROOT%\postgres\pgsql\bin"
set "PG_DATA=%LOCAL_ROOT%\pgdata"
set "PNPM_CJS=%LOCAL_ROOT%\pnpm\node_modules\pnpm\bin\pnpm.cjs"
set "LOG_DIR=%LOCAL_ROOT%\logs"

if not exist "%NODE_DIR%\node.exe" goto :not_ready
if not exist "%PG_BIN%\pg_ctl.exe" goto :not_ready
if not exist "%PNPM_CJS%" goto :not_ready
if not exist "%PG_DATA%\PG_VERSION" goto :not_ready

if not exist "%LOCAL_ROOT%\tmp" mkdir "%LOCAL_ROOT%\tmp"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if not exist "%LOCAL_ROOT%\proj" mkdir "%LOCAL_ROOT%\proj"
set "TEMP=%LOCAL_ROOT%\tmp"
set "TMP=%LOCAL_ROOT%\tmp"
set "npm_config_cache=%LOCAL_ROOT%\npm-cache"
set "PNPM_HOME=%LOCAL_ROOT%\pnpm-home"
set "PNPM_STORE_DIR=%LOCAL_ROOT%\pnpm-store"
set "PROJ_USER_WRITABLE_DIRECTORY=%LOCAL_ROOT%\proj"
set "PROJ_NETWORK=OFF"
set "PATH=%NODE_DIR%;%PG_BIN%;%PATH%"
set "NODE_ENV=development"
set "PORT=3000"
set "PUBLIC_BASE_URL=http://localhost:3000"
set "DATABASE_URL=postgres://spot@127.0.0.1:55432/spot"
set "DATABASE_SSL=false"
set "AUTH_DEV_MODE=true"
set "STORAGE_DRIVER=local"
set "CONTENT_CHECK_ENABLED=false"
set "AMAP_KEY="

"%PG_BIN%\pg_ctl.exe" status -D "%PG_DATA%" >nul 2>&1
if errorlevel 1 (
  "%PG_BIN%\pg_isready.exe" -h 127.0.0.1 -p 55432 -U spot -d postgres >nul 2>&1
  if not errorlevel 1 (
    echo 端口 55432 已被另一个 PostgreSQL 实例占用，已停止以保护数据。
    pause
    exit /b 1
  )
  echo [1/3] 正在启动便携 PostgreSQL...
  "%PG_BIN%\pg_ctl.exe" -D "%PG_DATA%" -l "%LOG_DIR%\postgres.log" -w start
  if errorlevel 1 (
    echo PostgreSQL 启动失败，请查看：%LOG_DIR%\postgres.log
    pause
    exit /b 1
  )
) else (
  echo [1/3] PostgreSQL 已经在运行。
)

"%PG_BIN%\pg_isready.exe" -h 127.0.0.1 -p 55432 -U spot -d spot >nul 2>&1
if errorlevel 1 (
  echo spot 数据库不可用，请重新运行 setup-portable.ps1。
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo 端口 3000 已被其他程序占用，未启动后端。
  pause
  exit /b 1
)

cd /d "%PROJECT_ROOT%api"
echo [2/3] 检查并执行数据库增量迁移...
"%NODE_DIR%\node.exe" "%PNPM_CJS%" migrate
if errorlevel 1 (
  echo 数据库迁移失败，未启动 API。请保留上述错误信息；不要删除数据库或重新写入种子数据。
  pause
  exit /b 1
)

echo [3/3] 启动后端开发服务...
echo 健康检查：http://localhost:3000/health
echo 按 Ctrl+C 可停止后端；数据库请用 stop-local.cmd 停止。
cd /d "%PROJECT_ROOT%api"
"%NODE_DIR%\node.exe" "%PNPM_CJS%" start:dev
exit /b %errorlevel%

:not_ready
echo 便携环境尚未准备完成，请先运行 setup-portable.ps1。
pause
exit /b 1

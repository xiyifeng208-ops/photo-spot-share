[CmdletBinding()]
param(
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$LocalRoot = Join-Path $ProjectRoot '.local'
$DownloadsDir = Join-Path $LocalRoot 'downloads'
$TempDir = Join-Path $LocalRoot 'tmp'
$LogsDir = Join-Path $LocalRoot 'logs'
$NodeDir = Join-Path $LocalRoot 'node'
$PostgresDir = Join-Path $LocalRoot 'postgres'
$PgRoot = Join-Path $PostgresDir 'pgsql'
$PgBin = Join-Path $PgRoot 'bin'
$PgData = Join-Path $LocalRoot 'pgdata'
$PnpmDir = Join-Path $LocalRoot 'pnpm'
$PnpmStore = Join-Path $LocalRoot 'pnpm-store'
$NpmCache = Join-Path $LocalRoot 'npm-cache'

$NodeVersion = '22.23.2'
$PnpmVersion = '9.15.9'
$PostgresVersion = '16.15'
$PostgisVersion = '3.6.2'
$DatabasePort = 55432
$DatabaseUrl = "postgres://spot@127.0.0.1:$DatabasePort/spot"

$NodeArchiveName = "node-v$NodeVersion-win-x64.zip"
$PostgresArchiveName = "postgresql-$PostgresVersion-1-windows-x64-binaries.zip"
$PostgisArchiveName = "postgis-bundle-pg16-$($PostgisVersion)x64.zip"

$NodeArchive = Join-Path $DownloadsDir $NodeArchiveName
$NodeChecksums = Join-Path $DownloadsDir "node-v$NodeVersion-SHASUMS256.txt"
$PostgresArchive = Join-Path $DownloadsDir $PostgresArchiveName
$PostgisArchive = Join-Path $DownloadsDir $PostgisArchiveName
$PostgisChecksum = Join-Path $DownloadsDir "$PostgisArchiveName.md5"

$NodeExe = Join-Path $NodeDir 'node.exe'
$NpmCmd = Join-Path $NodeDir 'npm.cmd'
$PnpmCjs = Join-Path $PnpmDir 'node_modules\pnpm\bin\pnpm.cjs'
$PnpmCmd = Join-Path $PnpmDir 'pnpm.cmd'
$PgCtl = Join-Path $PgBin 'pg_ctl.exe'
$PgIsReady = Join-Path $PgBin 'pg_isready.exe'
$Psql = Join-Path $PgBin 'psql.exe'
$Createdb = Join-Path $PgBin 'createdb.exe'
$PostgresExe = Join-Path $PgBin 'postgres.exe'
$PostgresLog = Join-Path $LogsDir 'postgres.log'

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-LocalPath([string]$Path) {
  $resolvedLocal = [IO.Path]::GetFullPath($LocalRoot).TrimEnd('\') + '\'
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedLocal, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作项目 .local 目录以外的路径：$resolvedPath"
  }
}

function Remove-LocalItem([string]$Path) {
  Assert-LocalPath $Path
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Invoke-Download {
  param(
    [string[]]$Uris,
    [string]$Destination
  )

  if (Test-Path -LiteralPath $Destination) {
    return
  }

  $partial = "$Destination.part"
  Assert-LocalPath $partial
  foreach ($uri in $Uris) {
    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
      try {
        Write-Host "下载 $uri（第 $attempt 次）"
        if (Test-Path -LiteralPath $partial) {
          Remove-Item -LiteralPath $partial -Force
        }
        Invoke-WebRequest -Uri $uri -OutFile $partial -UseBasicParsing -Headers @{
          'User-Agent' = 'photo-spot-share-portable-setup/1.0'
        }
        Move-Item -LiteralPath $partial -Destination $Destination -Force
        return
      } catch {
        Write-Warning $_.Exception.Message
        if (Test-Path -LiteralPath $partial) {
          Remove-Item -LiteralPath $partial -Force
        }
        if ($attempt -lt 3) {
          Start-Sleep -Seconds 2
        }
      }
    }
  }
  throw "下载失败：$($Uris -join ', ')"
}

function Test-ZipContains {
  param(
    [string]$Archive,
    [string]$RequiredSuffix
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    foreach ($entry in $zip.Entries) {
      $normalized = $entry.FullName.Replace('\', '/')
      if ($normalized.EndsWith($RequiredSuffix, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
    return $false
  } finally {
    $zip.Dispose()
  }
}

function Assert-FileHash {
  param(
    [string]$Path,
    [string]$Expected,
    [ValidateSet('SHA256', 'MD5')][string]$Algorithm
  )

  $actual = (Get-FileHash -LiteralPath $Path -Algorithm $Algorithm).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "$Algorithm 校验失败：$Path`n期望 $Expected`n实际 $actual"
  }
  Write-Host "$Algorithm 校验通过：$(Split-Path -Leaf $Path)"
}

function Restore-PostgresRuntimeDlls {
  # PostGIS bundle carries copies of seven DLLs that PostgreSQL itself also ships.
  # Keeping the newer PostgreSQL 16.15 copies is required for core extensions such
  # as pgcrypto; PostGIS-only files remain overlaid alongside them.
  $runtimeDlls = @(
    'bin/libcrypto-3-x64.dll',
    'bin/libcurl.dll',
    'bin/libiconv-2.dll',
    'bin/liblz4.dll',
    'bin/libssl-3-x64.dll',
    'bin/libzstd.dll',
    'bin/zlib1.dll'
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($PostgresArchive)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($relativePath in $runtimeDlls) {
      $entry = $zip.GetEntry("pgsql/$relativePath")
      if (-not $entry) {
        throw "PostgreSQL 归档缺少核心运行库：$relativePath"
      }
      $destination = Join-Path $PgRoot ($relativePath.Replace('/', '\'))
      $entryStream = $entry.Open()
      try {
        $expectedHash = [BitConverter]::ToString($sha256.ComputeHash($entryStream)).Replace('-', '')
      } finally {
        $entryStream.Dispose()
      }
      if (Test-Path -LiteralPath $destination) {
        $actualHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
        if ($actualHash -eq $expectedHash) {
          continue
        }
      }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    }
  } finally {
    $sha256.Dispose()
    $zip.Dispose()
  }
}

function Invoke-LocalPnpm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & $NodeExe $PnpmCjs @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm $($Arguments -join ' ') 执行失败（退出码 $LASTEXITCODE）"
  }
}

function Test-PostgresReady {
  & $PgIsReady -h 127.0.0.1 -p $DatabasePort -U spot -d postgres *> $null
  return $LASTEXITCODE -eq 0
}

function Assert-PortablePostgresIdentity {
  $actualRaw = & $Psql -X -h 127.0.0.1 -p $DatabasePort -U spot -d postgres -v ON_ERROR_STOP=1 -tAc 'SHOW data_directory'
  if ($LASTEXITCODE -ne 0) {
    throw "无法核验 127.0.0.1:$DatabasePort 上的 PostgreSQL 实例"
  }
  $actual = (($actualRaw | Out-String).Trim())
  $expectedPath = [IO.Path]::GetFullPath($PgData).TrimEnd('\', '/')
  $actualPath = [IO.Path]::GetFullPath($actual).TrimEnd('\', '/')
  if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "端口 $DatabasePort 已被其他 PostgreSQL 实例占用：$actualPath（期望 $expectedPath）"
  }
}

function Start-PortablePostgres {
  if (Test-PostgresReady) {
    Assert-PortablePostgresIdentity
    Write-Host "本项目 PostgreSQL 已在 127.0.0.1:$DatabasePort 运行"
    return
  }

  Write-Host "启动 PostgreSQL（端口 $DatabasePort）"
  & $PgCtl -D $PgData -l $PostgresLog -w start
  if ($LASTEXITCODE -ne 0) {
    Write-Warning 'pg_ctl 启动失败，改用 postgres.exe 后台启动。'
    $stdoutLog = Join-Path $LogsDir 'postgres-stdout.log'
    $stderrLog = Join-Path $LogsDir 'postgres-stderr.log'
    Start-Process -FilePath $PostgresExe `
      -ArgumentList @('-D', $PgData, '-p', "$DatabasePort") `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog | Out-Null
  }

  for ($attempt = 1; $attempt -le 40; $attempt += 1) {
    if (Test-PostgresReady) {
      Assert-PortablePostgresIdentity
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "PostgreSQL 未能在 20 秒内启动，请查看 $PostgresLog"
}

function Set-EnvValue {
  param(
    [string]$Path,
    [string]$Name,
    [string]$Value
  )

  # Windows PowerShell 5.1 默认会把无 BOM 的 UTF-8 当作系统代码页读取。
  # 显式使用 UTF-8，避免重复运行脚本时破坏 .env 里的中文注释。
  $utf8NoBom = [Text.UTF8Encoding]::new($false)
  $content = [IO.File]::ReadAllText($Path, $utf8NoBom)
  $line = "$Name=$Value"
  $pattern = "(?m)^$([regex]::Escape($Name))=.*$"
  if ([regex]::IsMatch($content, $pattern)) {
    $content = [regex]::Replace($content, $pattern, $line)
  } else {
    $content = $content.TrimEnd() + "`r`n$line`r`n"
  }
  [IO.File]::WriteAllText($Path, $content, $utf8NoBom)
}

Set-Location $ProjectRoot
foreach ($dir in @(
  $LocalRoot,
  $DownloadsDir,
  $TempDir,
  $LogsDir,
  $PnpmStore,
  $NpmCache,
  (Join-Path $LocalRoot 'pnpm-home'),
  (Join-Path $LocalRoot 'corepack'),
  (Join-Path $LocalRoot 'xdg-cache'),
  (Join-Path $LocalRoot 'proj')
)) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

# 所有工具缓存与临时文件均限制在项目目录内；只修改当前进程环境。
$env:TEMP = $TempDir
$env:TMP = $TempDir
$env:npm_config_cache = $NpmCache
$env:PNPM_HOME = Join-Path $LocalRoot 'pnpm-home'
$env:COREPACK_HOME = Join-Path $LocalRoot 'corepack'
$env:XDG_CACHE_HOME = Join-Path $LocalRoot 'xdg-cache'
$env:PNPM_STORE_DIR = $PnpmStore
$env:PROJ_USER_WRITABLE_DIRECTORY = Join-Path $LocalRoot 'proj'
$env:PROJ_NETWORK = 'OFF'

Write-Step '下载并校验官方运行时'
Invoke-Download @("https://nodejs.org/dist/v$NodeVersion/$NodeArchiveName") $NodeArchive
Invoke-Download @("https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt") $NodeChecksums
$nodeChecksumText = Get-Content -LiteralPath $NodeChecksums -Raw
$escapedNodeArchive = [regex]::Escape($NodeArchiveName)
$nodeHashMatch = [regex]::Match($nodeChecksumText, "(?im)^([0-9a-f]{64})\s+$escapedNodeArchive\s*$")
if (-not $nodeHashMatch.Success) {
  throw "Node 官方校验文件中没有找到 $NodeArchiveName"
}
Assert-FileHash $NodeArchive $nodeHashMatch.Groups[1].Value SHA256
if (-not (Test-ZipContains $NodeArchive '/node.exe')) {
  throw 'Node ZIP 结构不完整：缺少 node.exe'
}

Invoke-Download @(
  "https://get.enterprisedb.com/postgresql/$PostgresArchiveName"
) $PostgresArchive
if (-not (Test-ZipContains $PostgresArchive 'pgsql/bin/postgres.exe')) {
  throw 'PostgreSQL ZIP 结构不完整：缺少 pgsql/bin/postgres.exe'
}

$postgisPrimary = "https://download.osgeo.org/postgis/windows/pg16/$PostgisArchiveName"
$postgisMirror = "https://ftp.osuosl.org/pub/osgeo/download/postgis/windows/pg16/$PostgisArchiveName"
Invoke-Download @($postgisPrimary, $postgisMirror) $PostgisArchive
Invoke-Download @("$postgisPrimary.md5", "$postgisMirror.md5") $PostgisChecksum
$postgisChecksumText = Get-Content -LiteralPath $PostgisChecksum -Raw
$postgisHashMatch = [regex]::Match($postgisChecksumText, '(?i)\b([0-9a-f]{32})\b')
if (-not $postgisHashMatch.Success) {
  throw 'PostGIS MD5 文件格式无法识别'
}
Assert-FileHash $PostgisArchive $postgisHashMatch.Groups[1].Value MD5
if (-not (Test-ZipContains $PostgisArchive 'share/extension/postgis.control')) {
  throw 'PostGIS ZIP 结构不完整：缺少 postgis.control'
}

Write-Step '解压 Node.js'
$installedNodeVersion = if (Test-Path -LiteralPath $NodeExe) { (& $NodeExe --version 2>$null) } else { '' }
if ($installedNodeVersion -ne "v$NodeVersion") {
  Remove-LocalItem $NodeDir
  $nodeStage = Join-Path $TempDir 'extract-node'
  Remove-LocalItem $nodeStage
  New-Item -ItemType Directory -Path $nodeStage -Force | Out-Null
  Expand-Archive -LiteralPath $NodeArchive -DestinationPath $nodeStage -Force
  $nodeSource = Get-ChildItem -LiteralPath $nodeStage -Directory | Select-Object -First 1
  if (-not $nodeSource -or -not (Test-Path -LiteralPath (Join-Path $nodeSource.FullName 'node.exe'))) {
    throw 'Node 解压结果无法识别'
  }
  Move-Item -LiteralPath $nodeSource.FullName -Destination $NodeDir
  Remove-LocalItem $nodeStage
}
Write-Host "Node $(& $NodeExe --version)"

$env:PATH = "$NodeDir;$PgBin;$($env:PATH)"

Write-Step '安装项目内 pnpm'
$installedPnpmVersion = if (Test-Path -LiteralPath $PnpmCjs) { (& $NodeExe $PnpmCjs --version 2>$null) } else { '' }
if ($installedPnpmVersion -ne $PnpmVersion) {
  Remove-LocalItem $PnpmDir
  New-Item -ItemType Directory -Path $PnpmDir -Force | Out-Null
  & $NpmCmd install --prefix $PnpmDir --no-audit --no-fund --save=false "pnpm@$PnpmVersion"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $PnpmCjs)) {
    throw '项目内 pnpm 安装失败'
  }
}
$pnpmWrapper = "@echo off`r`n`"%~dp0..\node\node.exe`" `"%~dp0node_modules\pnpm\bin\pnpm.cjs`" %*`r`n"
[IO.File]::WriteAllText($PnpmCmd, $pnpmWrapper, [Text.Encoding]::ASCII)
Write-Host "pnpm $(& $NodeExe $PnpmCjs --version)"

Write-Step '解压 PostgreSQL 并合并 PostGIS'
$installedPostgresVersion = if (Test-Path -LiteralPath $PostgresExe) {
  (& $PostgresExe --version 2>$null) -replace '^postgres \(PostgreSQL\)\s+', ''
} else { '' }
if (-not $installedPostgresVersion.StartsWith($PostgresVersion)) {
  Remove-LocalItem $PostgresDir
  $pgStage = Join-Path $TempDir 'extract-postgres'
  Remove-LocalItem $pgStage
  New-Item -ItemType Directory -Path $pgStage -Force | Out-Null
  Expand-Archive -LiteralPath $PostgresArchive -DestinationPath $pgStage -Force
  $pgSource = Join-Path $pgStage 'pgsql'
  if (-not (Test-Path -LiteralPath (Join-Path $pgSource 'bin\postgres.exe'))) {
    throw 'PostgreSQL 解压结果无法识别'
  }
  New-Item -ItemType Directory -Path $PostgresDir -Force | Out-Null
  Move-Item -LiteralPath $pgSource -Destination $PgRoot
  Remove-LocalItem $pgStage
}

$postgisStamp = Join-Path $PostgresDir "postgis-$PostgisVersion.ready"
if (-not (Test-Path -LiteralPath $postgisStamp) -or -not (Test-Path -LiteralPath (Join-Path $PgRoot 'share\extension\postgis.control'))) {
  $postgisStage = Join-Path $TempDir 'extract-postgis'
  Remove-LocalItem $postgisStage
  New-Item -ItemType Directory -Path $postgisStage -Force | Out-Null
  Expand-Archive -LiteralPath $PostgisArchive -DestinationPath $postgisStage -Force
  $control = Get-ChildItem -LiteralPath $postgisStage -Recurse -Filter 'postgis.control' | Select-Object -First 1
  if (-not $control) {
    throw 'PostGIS 解压结果无法识别'
  }
  $extensionDir = Split-Path -Parent $control.FullName
  $shareDir = Split-Path -Parent $extensionDir
  $bundleRoot = Split-Path -Parent $shareDir
  Copy-Item -Path (Join-Path $bundleRoot '*') -Destination $PgRoot -Recurse -Force
  [IO.File]::WriteAllText($postgisStamp, $PostgisVersion, [Text.Encoding]::ASCII)
  Remove-LocalItem $postgisStage
}
Restore-PostgresRuntimeDlls
Write-Host "$(& $PostgresExe --version)"

Write-Step '初始化便携 PostgreSQL 数据库'
if (-not (Test-Path -LiteralPath (Join-Path $PgData 'PG_VERSION'))) {
  if ((Test-Path -LiteralPath $PgData) -and (Get-ChildItem -LiteralPath $PgData -Force | Select-Object -First 1)) {
    throw "$PgData 已存在但不是有效的 PostgreSQL 数据目录，请先人工检查。"
  }
  New-Item -ItemType Directory -Path $PgData -Force | Out-Null
  & (Join-Path $PgBin 'initdb.exe') -D $PgData -U spot -A trust -E UTF8 --locale=C
  if ($LASTEXITCODE -ne 0) {
    throw 'initdb 执行失败'
  }
} elseif ((Get-Content -LiteralPath (Join-Path $PgData 'PG_VERSION') -Raw).Trim() -ne '16') {
  throw "$PgData 不是 PostgreSQL 16 数据目录，已停止以避免损坏现有数据。"
}

$postgresConfig = Join-Path $PgData 'postgresql.conf'
$configMarker = '# photo-spot-share portable settings'
if (-not (Select-String -LiteralPath $postgresConfig -SimpleMatch $configMarker -Quiet)) {
  Add-Content -LiteralPath $postgresConfig -Encoding UTF8 -Value @"

$configMarker
listen_addresses = '127.0.0.1'
port = $DatabasePort
"@
}

Start-PortablePostgres
$spotExistsRaw = & $Psql -X -h 127.0.0.1 -p $DatabasePort -U spot -d postgres -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM pg_database WHERE datname='spot'"
if ($LASTEXITCODE -ne 0) {
  throw '检查 spot 数据库失败'
}
$spotExists = (($spotExistsRaw | Out-String).Trim())
if ($spotExists -ne '1') {
  & $Createdb -h 127.0.0.1 -p $DatabasePort -U spot spot
  if ($LASTEXITCODE -ne 0) {
    throw '创建 spot 数据库失败'
  }
}

Write-Step '生成本地后端配置'
$apiEnv = Join-Path $ProjectRoot 'api\.env'
$apiEnvLocal = Join-Path $ProjectRoot 'api\.env.local'
if (Test-Path -LiteralPath $apiEnvLocal) {
  throw "检测到 $apiEnvLocal；它会覆盖便携数据库配置。请先人工合并或移走该文件。"
}
if (-not (Test-Path -LiteralPath $apiEnv)) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot 'api\.env.example') -Destination $apiEnv
}
Set-EnvValue $apiEnv 'NODE_ENV' 'development'
Set-EnvValue $apiEnv 'PORT' '3000'
Set-EnvValue $apiEnv 'PUBLIC_BASE_URL' 'http://localhost:3000'
Set-EnvValue $apiEnv 'DATABASE_URL' $DatabaseUrl
Set-EnvValue $apiEnv 'DATABASE_SSL' 'false'
Set-EnvValue $apiEnv 'AUTH_DEV_MODE' 'true'
Set-EnvValue $apiEnv 'STORAGE_DRIVER' 'local'
Set-EnvValue $apiEnv 'CONTENT_CHECK_ENABLED' 'false'

Write-Step '安装后端依赖'
Set-Location (Join-Path $ProjectRoot 'api')
Invoke-LocalPnpm install --frozen-lockfile --store-dir $PnpmStore

# 即使跳过耗时测试，也必须留下可以启动的构建、表结构和演示数据。
Write-Step '构建后端并初始化业务数据'
Invoke-LocalPnpm build
Invoke-LocalPnpm migrate
$existingCountRaw = & $Psql -X -h 127.0.0.1 -p $DatabasePort -U spot -d spot -v ON_ERROR_STOP=1 -tAc 'SELECT count(*) FROM spots'
if ($LASTEXITCODE -ne 0) { throw '无法检查现有作品，已停止，未写入种子数据' }
if ([long]([string]$existingCountRaw).Trim() -eq 0) {
  Invoke-LocalPnpm seed
} else {
  Write-Host '已有作品，跳过演示种子，保留现有内容及收藏。'
}

if (-not $SkipChecks) {
  Write-Step '执行完整后端与数据库自检'
  Set-Location $ProjectRoot
  $env:PNPM_PATH = $PnpmCmd
  $checkDatabase = 'spot_test_setup_' + [guid]::NewGuid().ToString('N').Substring(0, 12)
  & $Createdb -h 127.0.0.1 -p $DatabasePort -U spot $checkDatabase
  if ($LASTEXITCODE -ne 0) { throw '独立测试库创建失败，未在日常库运行测试' }
  $checkDatabaseUrl = "postgres://spot@127.0.0.1:$DatabasePort/$checkDatabase"
  & $NodeExe (Join-Path $ProjectRoot 'tools\verify-local.mjs') --skip-install --db $checkDatabaseUrl
  if ($LASTEXITCODE -ne 0) {
    throw '完整后端自检失败'
  }

  Write-Step '执行小程序页面离线回归'
  foreach ($testScript in @(
    'tools\test-map-page.mjs',
    'tools\test-discover-page.mjs',
    'tools\test-discover-filters.mjs',
    'tools\test-favorites-page.mjs',
    'tools\test-create-page.mjs',
    'tools\test-publish-drafts.mjs',
    'tools\test-routes-page.mjs',
    'tools\test-detail-tools.mjs',
    'tools\test-favorite-counts.mjs'
  )) {
    & $NodeExe (Join-Path $ProjectRoot $testScript)
    if ($LASTEXITCODE -ne 0) {
      throw "页面测试失败：$testScript"
    }
  }
}

Write-Step '验证 PostGIS 扩展与空间函数'
$postgisResult = & $Psql -X -h 127.0.0.1 -p $DatabasePort -U spot -d spot -v ON_ERROR_STOP=1 -tAc @"
SELECT PostGIS_Full_Version();
SELECT ST_AsText(ST_Transform(ST_SetSRID(ST_Point(121.4737, 31.2304), 4326), 3857));
SELECT count(*) FROM spots WHERE id::text LIKE '11111111-1111-4111-8111-%';
"@
if ($LASTEXITCODE -ne 0) {
  throw 'PostGIS 扩展或空间函数验证失败'
}
$postgisText = ($postgisResult | Out-String)
if ($postgisText -notmatch 'POSTGIS="3\.6\.2' -or $postgisText -notmatch 'POINT\(') {
  throw "PostGIS 验证结果异常：`n$postgisText"
}
$resultLines = @($postgisResult | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
if ($resultLines[-1] -ne '6') {
  throw "演示机位数量异常，期望 6，实际 $($resultLines[-1])"
}
Write-Host $postgisText.Trim()

Write-Step '便携环境已准备完成'
Write-Host "项目目录：$ProjectRoot"
Write-Host "数据库：  127.0.0.1:$DatabasePort（spot）"
Write-Host '启动项目：双击 start-local.cmd'
Write-Host '停止数据库：双击 stop-local.cmd'

$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskCache = Join-Path $env:LOCALAPPDATA 'LegalAgentDev/runtime-18.4.0-beta.17/bin'
if (-not (Test-Path -LiteralPath $taskCache)) { throw '请先执行 npm run db:local 初始化本机开发数据库。' }
$taskDownload = Join-Path $taskProject '.local/downloads'
New-Item -ItemType Directory -Force -Path $taskDownload | Out-Null
$taskZip = Join-Path $taskDownload 'postgresql-18.4.zip'
if (-not (Test-Path -LiteralPath $taskZip)) { Invoke-WebRequest -Uri 'https://get.enterprisedb.com/postgresql/postgresql-18.4-1-windows-x64-binaries.zip' -OutFile $taskZip }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskArchive = [System.IO.Compression.ZipFile]::OpenRead($taskZip)
try {
  foreach ($taskName in @('pg_dump.exe','pg_restore.exe')) {
    $taskEntry = @($taskArchive.Entries | Where-Object { $_.FullName -eq ('pgsql/bin/' + $taskName) })
    if ($taskEntry.Count -ne 1) { throw ('缺少 PostgreSQL 工具：' + $taskName) }
    $taskTarget = Join-Path $taskCache $taskName
    if (-not (Test-Path -LiteralPath $taskTarget)) { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($taskEntry[0],$taskTarget,$false) }
  }
} finally { $taskArchive.Dispose() }
$taskEnv = Join-Path $taskProject '.env'
foreach ($taskSpec in @(@('PG_DUMP_PATH','pg_dump.exe'), @('PG_RESTORE_PATH','pg_restore.exe'))) {
  if (-not (Select-String -LiteralPath $taskEnv -Pattern ('^' + $taskSpec[0] + '=') -Quiet)) { Add-Content -LiteralPath $taskEnv -Value ($taskSpec[0] + '=' + (Join-Path $taskCache $taskSpec[1]).Replace('\','/')) }
}
Write-Output 'PostgreSQL 备份和恢复工具已准备；可执行 npm run backup。'

[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 10) { throw 'TimeoutSeconds must be at least 10' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronExecutable = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw "Electron executable is missing: $electronExecutable" }
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-desktop-smoke-" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $smokeRoot 'config.json'
$reportPath = Join-Path $smokeRoot 'manager.jsonl'
$userDataPath = Join-Path $smokeRoot 'user-data'
$process = $null
$success = $false
$old = @{}
foreach ($name in @('WIDGET_M1_CONFIG_PATH','WIDGET_M1_REPORT','WIDGET_M1_AUTO_EXIT_MS','WIDGET_M1_HOST_MODE','WIDGET_M1_TEST_DESKTOP_MS')) { $old[$name] = [Environment]::GetEnvironmentVariable($name) }

try {
  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $component = [ordered]@{
    instanceId = 'system-monitor-1'
    type = 'system-monitor'
    schemaVersion = 1
    displayName = 'system monitor'
    visible = $true
    locked = $true
    displayId = $null
    bounds = [ordered]@{ x = 16; y = 16; width = 520; height = 190; unit = 'dip' }
    theme = [ordered]@{ name = 'system'; opacity = 0.92 }
    config = [ordered]@{}
  }
  $config = [ordered]@{
    schemaVersion = 1
    layoutVersion = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    settings = [ordered]@{ theme = 'system'; globalLocked = $true; opacity = 0.92 }
    components = @($component)
  }
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = '5500'
  $env:WIDGET_M1_HOST_MODE = 'desktop'
  $env:WIDGET_M1_TEST_DESKTOP_MS = '2500'
  $process = Start-Process -FilePath $electronExecutable -ArgumentList @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox', $projectRoot, '--manager') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) { try { $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } }) } catch {} }
    if ($null -ne ($entries | Where-Object { $_.operation -eq 'desktop-host-test' -and $_.result -eq 'PASS' } | Select-Object -First 1)) { break }
    if ($process.HasExited) { throw "manager exited before desktop host test (exit code $($process.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }
  $ready = $null -ne ($entries | Where-Object { $_.operation -eq 'manager-ready' -and $_.result -eq 'RECORDED' } | Select-Object -First 1)
  $desktop = $null -ne ($entries | Where-Object { $_.operation -eq 'desktop-host-test' -and $_.result -eq 'PASS' } | Select-Object -First 1)
  if (-not $ready) { throw 'manager-ready was not recorded' }
  if (-not $desktop) { throw 'desktop host did not pass WorkerW attach, geometry and click-through validation' }
  if (-not $process.HasExited) { $process.WaitForExit(5000) | Out-Null }
  if (-not $process.HasExited) { throw 'manager process did not exit after desktop host test' }
  if ($process.ExitCode -ne 0) { throw "manager exited with code $($process.ExitCode)" }
  $success = $true
  Write-Host 'PASS desktop smoke; WorkerW attachment, desktop-layer geometry and locked click-through were verified'
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  if (Test-Path -LiteralPath $reportPath) { Get-Content -LiteralPath $reportPath }
  exit 1
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name]) }
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

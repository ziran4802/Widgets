[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 8) { throw 'TimeoutSeconds must be at least 8' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronExecutable = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw "Electron executable is missing: $electronExecutable" }
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-tray-smoke-" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $smokeRoot 'config.json'
$reportPath = Join-Path $smokeRoot 'manager.jsonl'
$userDataPath = Join-Path $smokeRoot 'user-data'
$process = $null
$success = $false
$oldConfigPath = $env:WIDGET_M1_CONFIG_PATH
$oldReportPath = $env:WIDGET_M1_REPORT
$oldAutoExit = $env:WIDGET_M1_AUTO_EXIT_MS
$oldTrayHide = $env:WIDGET_M1_TEST_TRAY_HIDE_MS

try {
  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = '3500'
  $env:WIDGET_M1_TEST_TRAY_HIDE_MS = '1200'
  $process = Start-Process -FilePath $electronExecutable -ArgumentList @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox', $projectRoot, '--manager') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) {
      try { $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } }) } catch {}
    }
    if ($null -ne ($entries | Where-Object { $_.operation -eq 'manager-complete' } | Select-Object -First 1)) { break }
    if ($process.HasExited) { throw "manager exited before tray lifecycle completed (exit code $($process.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }
  foreach ($expected in @(
    @{ operation = 'tray'; result = 'READY' }
    @{ operation = 'manager-window'; result = 'HIDDEN_TO_TRAY' }
    @{ operation = 'tray-test'; result = 'PASS' }
    @{ operation = 'manager-complete'; result = 'RECORDED' }
  )) {
    $found = $null -ne ($entries | Where-Object { $_.operation -eq $expected.operation -and $_.result -eq $expected.result } | Select-Object -First 1)
    if (-not $found) { throw "missing diagnostic: $($expected.operation)=$($expected.result)" }
  }
  if (-not $process.HasExited) { $process.WaitForExit(5000) | Out-Null }
  if (-not $process.HasExited) { throw 'manager did not exit after tray smoke' }
  if ($process.ExitCode -ne 0) { throw "manager exited with code $($process.ExitCode)" }
  $success = $true
  Write-Host 'PASS tray smoke; tray was created and manager hide-to-tray kept the process alive until explicit exit'
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  exit 1
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  $env:WIDGET_M1_CONFIG_PATH = $oldConfigPath
  $env:WIDGET_M1_REPORT = $oldReportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = $oldAutoExit
  $env:WIDGET_M1_TEST_TRAY_HIDE_MS = $oldTrayHide
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

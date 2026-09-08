[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 10) { throw 'TimeoutSeconds must be at least 10' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputRoot = Join-Path $projectRoot 'dist\Widget-portable'
$packageScript = Join-Path $PSScriptRoot 'portable-package.ps1'
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-portable-smoke-" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $smokeRoot 'config.json'
$reportPath = Join-Path $smokeRoot 'manager.jsonl'
$userDataPath = Join-Path $smokeRoot 'user-data'
$process = $null
$success = $false
$oldConfigPath = $env:WIDGET_M1_CONFIG_PATH
$oldReportPath = $env:WIDGET_M1_REPORT
$oldAutoExit = $env:WIDGET_M1_AUTO_EXIT_MS

try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $packageScript -OutputRoot $outputRoot
  if ($LASTEXITCODE -ne 0) { throw "portable package command failed with exit code $LASTEXITCODE" }
  $executable = Join-Path $outputRoot 'Widget.exe'
  if (-not (Test-Path -LiteralPath $executable)) { throw 'portable executable is missing' }

  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = '3500'
  # Validate the real user path: double-clicking Widget.exe supplies no mode flag.
  $process = Start-Process -FilePath $executable -ArgumentList @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) {
      try { $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } }) } catch {}
    }
    $complete = $null -ne ($entries | Where-Object { $_.operation -eq 'manager-complete' -and $_.result -eq 'RECORDED' } | Select-Object -First 1)
    if ($complete) { break }
    if ($process.HasExited) { throw "packaged manager exited before manager-complete (exit code $($process.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }
  $ready = $null -ne ($entries | Where-Object { $_.operation -eq 'manager-ready' -and $_.result -eq 'RECORDED' } | Select-Object -First 1)
  $complete = $null -ne ($entries | Where-Object { $_.operation -eq 'manager-complete' -and $_.result -eq 'RECORDED' } | Select-Object -First 1)
  if (-not $ready) { throw 'packaged manager-ready was not recorded' }
  if (-not $complete) { throw 'packaged manager-complete was not recorded' }
  if (-not $process.HasExited) { $process.WaitForExit(5000) | Out-Null }
  if (-not $process.HasExited) { throw 'packaged manager did not exit' }
  if ($process.ExitCode -ne 0) { throw "packaged manager exited with code $($process.ExitCode)" }
  $success = $true
  Write-Host 'PASS portable package smoke; packaged Widget.exe completed manager lifecycle'
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  exit 1
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  $env:WIDGET_M1_CONFIG_PATH = $oldConfigPath
  $env:WIDGET_M1_REPORT = $oldReportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = $oldAutoExit
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

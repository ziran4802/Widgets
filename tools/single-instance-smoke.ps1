[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 12) { throw 'TimeoutSeconds must be at least 12' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronExecutable = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw "Electron executable is missing: $electronExecutable" }
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-single-instance-smoke-" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $smokeRoot 'config.json'
$reportPath = Join-Path $smokeRoot 'manager.jsonl'
$userDataPath = Join-Path $smokeRoot 'user-data'
$first = $null
$second = $null
$third = $null
$success = $false
$oldConfigPath = $env:WIDGET_M1_CONFIG_PATH
$oldReportPath = $env:WIDGET_M1_REPORT
$oldAutoExit = $env:WIDGET_M1_AUTO_EXIT_MS

try {
  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = '9000'

  $electronArgs = @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox', $projectRoot, '--manager')
  $first = Start-Process -FilePath $electronExecutable -ArgumentList $electronArgs -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) {
      try { $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } }) } catch {}
    }
    if ($null -ne ($entries | Where-Object { $_.operation -eq 'manager-ready' } | Select-Object -First 1)) { break }
    if ($first.HasExited) { throw "first manager exited before manager-ready (exit code $($first.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }

  $second = Start-Process -FilePath $electronExecutable -ArgumentList $electronArgs -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $third = Start-Process -FilePath $electronExecutable -ArgumentList @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox', $projectRoot, '--manager', '--autostart') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) {
      try { $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } }) } catch {}
    }
    $focused = $null -ne ($entries | Where-Object { $_.operation -eq 'second-instance' -and $_.result -eq 'FOCUSED' } | Select-Object -First 1)
    $ignored = $null -ne ($entries | Where-Object { $_.operation -eq 'second-instance' -and $_.result -eq 'IGNORED_SILENT_AUTOSTART' } | Select-Object -First 1)
    if ($focused -and $ignored) { break }
    if ($first.HasExited) { throw "first manager exited before second-instance decisions (exit code $($first.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }

  $focused = $null -ne ($entries | Where-Object { $_.operation -eq 'second-instance' -and $_.result -eq 'FOCUSED' } | Select-Object -First 1)
  $ignored = $null -ne ($entries | Where-Object { $_.operation -eq 'second-instance' -and $_.result -eq 'IGNORED_SILENT_AUTOSTART' } | Select-Object -First 1)
  if (-not $focused) { throw 'manual second instance did not record FOCUSED' }
  if (-not $ignored) { throw 'silent autostart second instance did not record IGNORED_SILENT_AUTOSTART' }
  if (-not $second.HasExited) { $second.WaitForExit(5000) | Out-Null }
  if (-not $third.HasExited) { $third.WaitForExit(5000) | Out-Null }
  if (-not $first.HasExited) { $first.WaitForExit(12000) | Out-Null }
  if (-not $first.HasExited) { throw 'first manager did not exit after auto-exit' }
  if ($first.ExitCode -ne 0) { throw "first manager exited with code $($first.ExitCode)" }
  $success = $true
  Write-Host 'PASS single-instance smoke; manual launch focused manager and silent autostart did not steal focus'
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  exit 1
} finally {
  foreach ($process in @($first, $second, $third)) {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  $env:WIDGET_M1_CONFIG_PATH = $oldConfigPath
  $env:WIDGET_M1_REPORT = $oldReportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = $oldAutoExit
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

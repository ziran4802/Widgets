[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 8) { throw 'TimeoutSeconds must be at least 8' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronExecutable = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw "Electron executable is missing: $electronExecutable" }
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-renderer-recovery-" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $smokeRoot 'config.json'
$reportPath = Join-Path $smokeRoot 'manager.jsonl'
$userDataPath = Join-Path $smokeRoot 'user-data'
$process = $null
$success = $false
$oldConfigPath = $env:WIDGET_M1_CONFIG_PATH
$oldReportPath = $env:WIDGET_M1_REPORT
$oldAutoExit = $env:WIDGET_M1_AUTO_EXIT_MS
$oldCrashDelay = $env:WIDGET_M1_TEST_RENDERER_CRASH_MS
$oldCrashInstance = $env:WIDGET_M1_TEST_RENDERER_CRASH_INSTANCE

try {
  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $config = [ordered]@{
    schemaVersion = 1
    layoutVersion = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    settings = [ordered]@{ theme = 'system'; globalLocked = $true }
    components = @(
      [ordered]@{
        instanceId = 'system-monitor-1'
        type = 'system-monitor'
        schemaVersion = 1
        displayName = 'system monitor'
        visible = $true
        locked = $true
        displayId = $null
        bounds = [ordered]@{ x = 16; y = 16; width = 360; height = 160; unit = 'dip' }
        theme = [ordered]@{ name = 'system'; opacity = 0.92 }
        config = [ordered]@{}
      }
    )
  }
  $json = $config | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = '6500'
  $env:WIDGET_M1_TEST_RENDERER_CRASH_MS = '1800'
  $env:WIDGET_M1_TEST_RENDERER_CRASH_INSTANCE = 'system-monitor-1'

  $process = Start-Process -FilePath $electronExecutable -ArgumentList @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox', $projectRoot, '--manager') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) {
      try {
        $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } })
      } catch {
        # The JSONL file may be between two writes; retry on the next poll.
      }
    }
    $complete = $null -ne ($entries | Where-Object { $_.operation -eq 'manager-complete' } | Select-Object -First 1)
    if ($complete) { break }
    if ($process.HasExited) { throw "manager exited before manager-complete (exit code $($process.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }

  $required = @(
    @{ operation = 'manager-ready'; result = 'RECORDED' }
    @{ operation = 'renderer-recovery-test'; result = 'TRIGGERED' }
    @{ operation = 'component-window'; result = 'RECOVERING' }
    @{ operation = 'component-window'; result = 'RECOVERED' }
    @{ operation = 'manager-complete'; result = 'RECORDED' }
  )
  foreach ($expected in $required) {
    $found = $null -ne ($entries | Where-Object { $_.operation -eq $expected.operation -and $_.result -eq $expected.result } | Select-Object -First 1)
    if (-not $found) { throw "missing diagnostic: $($expected.operation)=$($expected.result)" }
  }
  if (-not $process.HasExited) { $process.WaitForExit(5000) | Out-Null }
  if (-not $process.HasExited) { throw 'manager process did not exit after manager-complete' }
  if ($process.ExitCode -ne 0) { throw "manager exited with code $($process.ExitCode)" }

  $success = $true
  Write-Host 'PASS renderer recovery smoke test; renderer crash was triggered through the widget window reference and recovery was recorded'
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  exit 1
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  $env:WIDGET_M1_CONFIG_PATH = $oldConfigPath
  $env:WIDGET_M1_REPORT = $oldReportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = $oldAutoExit
  $env:WIDGET_M1_TEST_RENDERER_CRASH_MS = $oldCrashDelay
  $env:WIDGET_M1_TEST_RENDERER_CRASH_INSTANCE = $oldCrashInstance
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

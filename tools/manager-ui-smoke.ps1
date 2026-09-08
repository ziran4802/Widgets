[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 8) { throw 'TimeoutSeconds must be at least 8' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronExecutable = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw "Electron executable is missing: $electronExecutable" }
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-manager-ui-smoke-" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $smokeRoot 'config.json'
$reportPath = Join-Path $smokeRoot 'manager.jsonl'
$userDataPath = Join-Path $smokeRoot 'user-data'
$process = $null
$success = $false
$old = @{}
foreach ($name in @('WIDGET_M1_CONFIG_PATH','WIDGET_M1_REPORT','WIDGET_M1_AUTO_EXIT_MS','WIDGET_M1_TEST_MANAGER_UI_MS')) { $old[$name] = [Environment]::GetEnvironmentVariable($name) }

try {
  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $base = @(
    [ordered]@{ instanceId = 'system-monitor-1'; type = 'system-monitor'; schemaVersion = 1; displayName = 'system monitor'; visible = $true; locked = $true; displayId = $null; bounds = [ordered]@{ x = 16; y = 16; width = 520; height = 190; unit = 'dip' }; theme = [ordered]@{ name = 'system'; opacity = 0.92 }; config = [ordered]@{} }
    [ordered]@{ instanceId = 'clock-date-1'; type = 'clock-date'; schemaVersion = 1; displayName = 'clock'; visible = $true; locked = $true; displayId = $null; bounds = [ordered]@{ x = 16; y = 220; width = 280; height = 128; unit = 'dip' }; theme = [ordered]@{ name = 'system'; opacity = 0.92 }; config = [ordered]@{ format = '24h'; showSeconds = $true } }
    [ordered]@{ instanceId = 'note-1'; type = 'note'; schemaVersion = 1; displayName = 'note'; visible = $true; locked = $true; displayId = $null; bounds = [ordered]@{ x = 320; y = 16; width = 300; height = 260; unit = 'dip' }; theme = [ordered]@{ name = 'system'; opacity = 0.92 }; config = [ordered]@{ title = ''; text = ''; size = 'standard'; background = 'yellow' } }
    [ordered]@{ instanceId = 'codex-quota-1'; type = 'codex-quota'; schemaVersion = 1; displayName = 'codex quota'; visible = $true; locked = $true; displayId = $null; bounds = [ordered]@{ x = 16; y = 336; width = 680; height = 300; unit = 'dip' }; theme = [ordered]@{ name = 'system'; opacity = 0.92 }; config = [ordered]@{} }
  )
  $config = [ordered]@{ schemaVersion = 1; layoutVersion = 1; updatedAt = (Get-Date).ToUniversalTime().ToString('o'); settings = [ordered]@{ theme = 'system'; globalLocked = $true; opacity = 0.92 }; components = $base }
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = '4800'
  $env:WIDGET_M1_TEST_MANAGER_UI_MS = '1800'
  $process = Start-Process -FilePath $electronExecutable -ArgumentList @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox', $projectRoot, '--manager') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) { try { $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } }) } catch {} }
    if ($null -ne ($entries | Where-Object { $_.operation -eq 'manager-ui-test' -and $_.result -eq 'PASS' } | Select-Object -First 1)) { break }
    if ($process.HasExited) { throw "manager exited before manager-ui-test (exit code $($process.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }
  foreach ($expected in @(
    @{ operation = 'manager-ready'; result = 'RECORDED' }
    @{ operation = 'manager-ui-test'; result = 'PASS' }
  )) {
    if ($null -eq ($entries | Where-Object { $_.operation -eq $expected.operation -and $_.result -eq $expected.result } | Select-Object -First 1)) { throw "missing diagnostic: $($expected.operation)=$($expected.result)" }
  }
  if (-not $process.HasExited) { $process.WaitForExit(5000) | Out-Null }
  if (-not $process.HasExited) { throw 'manager process did not exit after manager-complete' }
  if ($process.ExitCode -ne 0) { throw "manager exited with code $($process.ExitCode)" }
  $saved = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  if ($saved.settings.theme -ne 'light') { throw 'appearance theme change was not persisted' }
  $success = $true
  Write-Host 'PASS manager UI smoke; navigation, catalog previews, added instances, appearance and autostart settings pages were verified'
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  exit 1
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name]) }
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

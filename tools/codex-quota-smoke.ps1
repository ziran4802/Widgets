[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 8) { throw 'TimeoutSeconds must be at least 8' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronExecutable = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw "Electron executable is missing: $electronExecutable" }
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-codex-quota-smoke-" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $smokeRoot 'config.json'
$reportPath = Join-Path $smokeRoot 'manager.jsonl'
$userDataPath = Join-Path $smokeRoot 'user-data'
$process = $null
$success = $false
$old = @{}
foreach ($name in @('WIDGET_M1_CONFIG_PATH','WIDGET_M1_REPORT','WIDGET_M1_AUTO_EXIT_MS','WIDGET_M1_TEST_CODEX_QUOTA','WIDGET_M1_TEST_CODEX_QUOTA_MS')) { $old[$name] = [Environment]::GetEnvironmentVariable($name) }

try {
  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $component = [ordered]@{
    instanceId = 'codex-quota-1'
    type = 'codex-quota'
    schemaVersion = 1
    displayName = 'codex quota'
    visible = $true
    locked = $true
    displayId = $null
    bounds = [ordered]@{ x = 16; y = 16; width = 680; height = 300; unit = 'dip' }
    theme = [ordered]@{ name = 'light'; opacity = 0.92 }
    config = [ordered]@{}
  }
  $config = [ordered]@{
    schemaVersion = 1
    layoutVersion = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    settings = [ordered]@{ theme = 'light'; globalLocked = $true; opacity = 0.92 }
    components = @($component)
  }
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
  $fixture = [ordered]@{
    primary = [ordered]@{ usedPercent = 38; windowDurationMins = 300; resetsAt = 4102444800 }
    secondary = [ordered]@{ usedPercent = 22; windowDurationMins = 10080; resetsAt = 4102444800 }
  }
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = '4800'
  $env:WIDGET_M1_TEST_CODEX_QUOTA = $fixture | ConvertTo-Json -Compress -Depth 10
  $env:WIDGET_M1_TEST_CODEX_QUOTA_MS = '1800'
  $process = Start-Process -FilePath $electronExecutable -ArgumentList @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox', $projectRoot, '--manager') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) { try { $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } }) } catch {} }
    if ($null -ne ($entries | Where-Object { $_.operation -eq 'codex-quota-test' -and $_.result -eq 'PASS' } | Select-Object -First 1)) { break }
    if ($process.HasExited) { throw "manager exited before codex quota test (exit code $($process.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }
  foreach ($expected in @(
    @{ operation = 'manager-ready'; result = 'RECORDED' }
    @{ operation = 'codex-quota-test'; result = 'PASS' }
  )) {
    if ($null -eq ($entries | Where-Object { $_.operation -eq $expected.operation -and $_.result -eq $expected.result } | Select-Object -First 1)) { throw "missing diagnostic: $($expected.operation)=$($expected.result)" }
  }
  if (-not $process.HasExited) { $process.WaitForExit(5000) | Out-Null }
  if (-not $process.HasExited) { throw 'manager process did not exit after manager-complete' }
  if ($process.ExitCode -ne 0) { throw "manager exited with code $($process.ExitCode)" }
  $saved = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  if ($saved.components[0].type -ne 'codex-quota') { throw 'Codex quota component was not restored' }
  $success = $true
  Write-Host 'PASS Codex quota smoke; local-only Codex layout, quota windows, reset state and no-cost UI were verified'
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  exit 1
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name]) }
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 8) { throw 'TimeoutSeconds must be at least 8' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronExecutable = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw "Electron executable is missing: $electronExecutable" }
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-todo-smoke-" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $smokeRoot 'config.json'
$reportPath = Join-Path $smokeRoot 'manager.jsonl'
$userDataPath = Join-Path $smokeRoot 'user-data'
$process = $null
$success = $false
$old = @{}
foreach ($name in @('WIDGET_M1_CONFIG_PATH','WIDGET_M1_REPORT','WIDGET_M1_AUTO_EXIT_MS','WIDGET_M1_TEST_TODO_MS','WIDGET_M1_TEST_TODO_TITLE')) { $old[$name] = [Environment]::GetEnvironmentVariable($name) }
$today = (Get-Date).ToString('yyyy-MM-dd')
$title = 'smoke todo'

try {
  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $config = [ordered]@{
    schemaVersion = 1
    layoutVersion = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    settings = [ordered]@{ theme = 'system'; globalLocked = $true }
    components = @(
      [ordered]@{
        instanceId = 'daily-todo-1'
        type = 'daily-todo'
        schemaVersion = 1
        displayName = 'daily todo'
        visible = $true
        locked = $true
        displayId = $null
        bounds = [ordered]@{ x = 16; y = 336; width = 360; height = 420; unit = 'dip' }
        theme = [ordered]@{ name = 'system'; opacity = 0.92 }
        config = [ordered]@{
          dateKey = $today
          items = @([ordered]@{ id = 'todo-1'; title = 'initial task'; completed = $false })
        }
      }
    )
  }
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = '5200'
  $env:WIDGET_M1_TEST_TODO_MS = '1800'
  $env:WIDGET_M1_TEST_TODO_TITLE = $title

  $process = Start-Process -FilePath $electronExecutable -ArgumentList @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox', $projectRoot, '--manager') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) { try { $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } }) } catch {} }
    $complete = $null -ne ($entries | Where-Object { $_.operation -eq 'manager-complete' -and $_.result -eq 'RECORDED' } | Select-Object -First 1)
    if ($complete) { break }
    if ($process.HasExited) { throw "manager exited before manager-complete (exit code $($process.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }
  foreach ($expected in @(
    @{ operation = 'manager-ready'; result = 'RECORDED' }
    @{ operation = 'todo-edit-test'; result = 'TRIGGERED' }
    @{ operation = 'todo-save-test'; result = 'SAVED' }
    @{ operation = 'manager-complete'; result = 'RECORDED' }
  )) {
    if ($null -eq ($entries | Where-Object { $_.operation -eq $expected.operation -and $_.result -eq $expected.result } | Select-Object -First 1)) { throw "missing diagnostic: $($expected.operation)=$($expected.result)" }
  }
  $saved = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  $todo = @($saved.components | Where-Object { $_.instanceId -eq 'daily-todo-1' })[0]
  $items = @($todo.config.items)
  if ($todo.config.dateKey -ne $today) { throw 'saved todo date does not match the smoke date' }
  if ($null -eq ($items | Where-Object { $_.title -eq $title -and $_.completed -eq $false } | Select-Object -First 1)) { throw 'added todo item was not persisted' }
  if ($null -eq ($items | Where-Object { $_.title -eq 'initial task' -and $_.completed -eq $true } | Select-Object -First 1)) { throw 'toggled todo item was not persisted' }
  if (-not $process.HasExited) { $process.WaitForExit(5000) | Out-Null }
  if (-not $process.HasExited) { throw 'manager process did not exit after manager-complete' }
  if ($process.ExitCode -ne 0) { throw "manager exited with code $($process.ExitCode)" }
  $success = $true
  Write-Host 'PASS todo smoke; renderer add/toggle interactions, controlled IPC and persisted daily todo state were verified'
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  exit 1
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name]) }
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

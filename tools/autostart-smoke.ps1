[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 10) { throw 'TimeoutSeconds must be at least 10' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputRoot = Join-Path $projectRoot 'dist\Widget-portable'
$packageScript = Join-Path $PSScriptRoot 'portable-package.ps1'
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-autostart-smoke-" + [guid]::NewGuid().ToString('N'))
$configPath = Join-Path $smokeRoot 'config.json'
$reportPath = Join-Path $smokeRoot 'manager.jsonl'
$userDataPath = Join-Path $smokeRoot 'user-data'
$process = $null
$success = $false
$old = @{}
foreach ($name in @('WIDGET_M1_CONFIG_PATH','WIDGET_M1_REPORT','WIDGET_M1_AUTO_EXIT_MS')) { $old[$name] = [Environment]::GetEnvironmentVariable($name) }

try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $packageScript -OutputRoot $outputRoot
  if ($LASTEXITCODE -ne 0) { throw "portable package command failed with exit code $LASTEXITCODE" }
  $executable = Join-Path $outputRoot 'Widget.exe'
  if (-not (Test-Path -LiteralPath $executable)) { throw 'portable executable is missing' }

  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $config = [ordered]@{
    schemaVersion = 1
    layoutVersion = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    settings = [ordered]@{ theme = 'system'; globalLocked = $true; opacity = 0.92 }
    components = @(
      [ordered]@{
        instanceId = 'system-monitor-1'; type = 'system-monitor'; schemaVersion = 1; displayName = 'system monitor'; visible = $true; locked = $true; displayId = $null
        bounds = [ordered]@{ x = 16; y = 16; width = 520; height = 190; unit = 'dip' }
        theme = [ordered]@{ name = 'system'; opacity = 0.92 }; config = [ordered]@{}
      }
    )
  }
  [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = '3500'
  # This exercises the real packaged command line used by the login item. It never calls
  # enable/disable, so the smoke cannot create or modify a real Windows startup entry.
  $process = Start-Process -FilePath $executable -ArgumentList @('--autostart', '--silent-autostart', "--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $reportPath) {
      try { $entries = @(Get-Content -LiteralPath $reportPath | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } }) } catch {}
    }
    $complete = $null -ne ($entries | Where-Object { $_.operation -eq 'manager-complete' -and $_.result -eq 'RECORDED' } | Select-Object -First 1)
    if ($complete) { break }
    if ($process.HasExited) { throw "silent autostart process exited before manager-complete (exit code $($process.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }
  foreach ($expected in @(
    @{ operation = 'manager-ready'; result = 'RECORDED' }
    @{ operation = 'manager-window'; result = 'HIDDEN_SILENT_AUTOSTART' }
    @{ operation = 'manager-complete'; result = 'RECORDED' }
  )) {
    if ($null -eq ($entries | Where-Object { $_.operation -eq $expected.operation -and $_.result -eq $expected.result } | Select-Object -First 1)) { throw "missing diagnostic: $($expected.operation)=$($expected.result)" }
  }
  if (-not $process.HasExited) { $process.WaitForExit(5000) | Out-Null }
  if (-not $process.HasExited) { throw 'silent autostart process did not exit' }
  if ($process.ExitCode -ne 0) { throw "silent autostart process exited with code $($process.ExitCode)" }
  $success = $true
  Write-Host 'PASS autostart smoke; packaged Widget.exe restored visible components without showing the manager'
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  exit 1
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  foreach ($name in $old.Keys) { [Environment]::SetEnvironmentVariable($name, $old[$name]) }
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

[CmdletBinding()]
param(
  [string]$OutputPath = 'diagnostics/performance-report.json',
  [int]$TimeoutSeconds = 30,
  [int]$SampleSeconds = 3
)

$ErrorActionPreference = 'Stop'
if ($TimeoutSeconds -lt 10) { throw 'TimeoutSeconds must be at least 10' }
if ($SampleSeconds -lt 1) { throw 'SampleSeconds must be at least 1' }

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electronExecutable = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExecutable)) { throw "Electron executable is missing: $electronExecutable" }
$outputFile = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  [System.IO.Path]::GetFullPath($OutputPath)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputPath))
}
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("widget-performance-" + [guid]::NewGuid().ToString('N'))
$script:performanceProcess = $null
$success = $false
$oldConfigPath = $env:WIDGET_M1_CONFIG_PATH
$oldReportPath = $env:WIDGET_M1_REPORT
$oldAutoExit = $env:WIDGET_M1_AUTO_EXIT_MS
$oldCrashDelay = $env:WIDGET_M1_TEST_RENDERER_CRASH_MS
$oldCrashInstance = $env:WIDGET_M1_TEST_RENDERER_CRASH_INSTANCE

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Get-ElectronIds() {
  @(Get-Process -Name electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}

function Get-ProcessSnapshot([int[]]$Ids) {
  $items = @()
  foreach ($id in @($Ids)) {
    $item = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $item) { continue }
    $cpuSeconds = 0.0
    try { $cpuSeconds = [double]$item.TotalProcessorTime.TotalSeconds } catch {}
    $items += [pscustomobject]@{
      processId = [int]$item.Id
      name = [string]$item.ProcessName
      workingSetBytes = [int64]$item.WorkingSet64
      cpuSeconds = $cpuSeconds
    }
  }
  @($items)
}

function New-TestConfig([int]$ComponentCount, [string]$Path) {
  $components = @()
  if ($ComponentCount -ge 1) {
    $components += [ordered]@{
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
  }
  if ($ComponentCount -ge 2) {
    $components += [ordered]@{
      instanceId = 'clock-date-1'
      type = 'clock-date'
      schemaVersion = 1
      displayName = 'clock date'
      visible = $true
      locked = $true
      displayId = $null
      bounds = [ordered]@{ x = 16; y = 192; width = 280; height = 128; unit = 'dip' }
      theme = [ordered]@{ name = 'system'; opacity = 0.92 }
      config = [ordered]@{ format = '24h'; showSeconds = $true }
    }
  }
  $config = [ordered]@{
    schemaVersion = 1
    layoutVersion = 1
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    settings = [ordered]@{ theme = 'system'; globalLocked = $true }
    components = $components
  }
  Write-Utf8NoBom $Path (($config | ConvertTo-Json -Depth 8))
}

function Read-Entries([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  try {
    @(Get-Content -LiteralPath $Path | ForEach-Object { if ($_.Trim()) { $_ | ConvertFrom-Json } })
  } catch {
    @()
  }
}

function Find-Entry($Entries, [string]$Operation, [string]$Result) {
  $Entries | Where-Object { $_.operation -eq $Operation -and $_.result -eq $Result } | Select-Object -First 1
}

function Measure-Scenario($Scenario) {
  if ($Scenario.closed) {
    return [ordered]@{
      name = $Scenario.name
      componentCount = 0
      recovery = $false
      closed = $true
      startupMs = $null
      processCount = 0
      peakWorkingSetBytes = 0
      peakCpuPercentOfMachine = 0
      recoveryMs = $null
      managerExitCode = $null
    }
  }
  $configPath = Join-Path $smokeRoot "$($Scenario.name).json"
  $reportPath = Join-Path $smokeRoot "$($Scenario.name).jsonl"
  $userDataPath = Join-Path $smokeRoot "$($Scenario.name)-user-data"
  New-TestConfig $Scenario.componentCount $configPath
  $baselineIds = @(Get-ElectronIds)
  $startUtc = [DateTimeOffset]::UtcNow
  $env:WIDGET_M1_CONFIG_PATH = $configPath
  $env:WIDGET_M1_REPORT = $reportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = if ($Scenario.recovery) { '6500' } else { '5000' }
  if ($Scenario.recovery) {
    $env:WIDGET_M1_TEST_RENDERER_CRASH_MS = '1800'
    $env:WIDGET_M1_TEST_RENDERER_CRASH_INSTANCE = 'system-monitor-1'
  } else {
    $env:WIDGET_M1_TEST_RENDERER_CRASH_MS = '0'
    $env:WIDGET_M1_TEST_RENDERER_CRASH_INSTANCE = $null
  }

  $script:performanceProcess = Start-Process -FilePath $electronExecutable -ArgumentList @("--user-data-dir=$userDataPath", '--disable-gpu', '--no-sandbox', $projectRoot, '--manager') -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $entries = @()
  while ((Get-Date) -lt $deadline) {
    $entries = Read-Entries $reportPath
    if (Find-Entry $entries 'manager-ready' 'RECORDED') { break }
    if ($script:performanceProcess.HasExited) { throw "$($Scenario.name): manager exited before manager-ready (exit code $($script:performanceProcess.ExitCode))" }
    Start-Sleep -Milliseconds 200
  }
  $ready = Find-Entry $entries 'manager-ready' 'RECORDED'
  if (-not $ready) { throw "$($Scenario.name): manager-ready was not recorded within $TimeoutSeconds seconds" }

  $observedIds = @(Get-ElectronIds | Where-Object { $baselineIds -notcontains $_ })
  $initialSnapshot = Get-ProcessSnapshot $observedIds
  $peakWorkingSet = [int64](($initialSnapshot | Measure-Object -Property workingSetBytes -Sum).Sum)
  $peakCpuPercent = 0.0
  $previousSnapshot = $initialSnapshot
  $previousAt = [DateTimeOffset]::UtcNow
  $sampleDeadline = (Get-Date).AddSeconds($SampleSeconds)
  while ((Get-Date) -lt $sampleDeadline) {
    Start-Sleep -Milliseconds 500
    $currentSnapshot = Get-ProcessSnapshot $observedIds
    $now = [DateTimeOffset]::UtcNow
    $elapsedSeconds = ($now - $previousAt).TotalSeconds
    if ($elapsedSeconds -gt 0) {
      $previousById = @{}
      foreach ($item in $previousSnapshot) { $previousById[$item.processId] = $item.cpuSeconds }
      $cpuDelta = 0.0
      foreach ($item in $currentSnapshot) {
        if ($previousById.ContainsKey($item.processId)) { $cpuDelta += $item.cpuSeconds - $previousById[$item.processId] }
      }
      $cpuPercent = [Math]::Max(0, ($cpuDelta / $elapsedSeconds / [Environment]::ProcessorCount) * 100)
      $peakCpuPercent = [Math]::Max($peakCpuPercent, $cpuPercent)
    }
    $workingSet = [int64](($currentSnapshot | Measure-Object -Property workingSetBytes -Sum).Sum)
    $peakWorkingSet = [Math]::Max($peakWorkingSet, $workingSet)
    $previousSnapshot = $currentSnapshot
    $previousAt = $now
  }

  if (-not $script:performanceProcess.HasExited) { $script:performanceProcess.WaitForExit(7000) | Out-Null }
  if (-not $script:performanceProcess.HasExited) { throw "$($Scenario.name): manager did not exit" }
  $entries = Read-Entries $reportPath
  $complete = Find-Entry $entries 'manager-complete' 'RECORDED'
  if (-not $complete) { throw "$($Scenario.name): manager-complete was not recorded" }
  if ($script:performanceProcess.ExitCode -ne 0) { throw "$($Scenario.name): manager exited with code $($script:performanceProcess.ExitCode)" }

  $recoveryMs = $null
  $triggered = Find-Entry $entries 'renderer-recovery-test' 'TRIGGERED'
  $recovered = Find-Entry $entries 'component-window' 'RECOVERED'
  if ($Scenario.recovery) {
    if (-not $triggered -or -not $recovered) { throw "$($Scenario.name): renderer recovery diagnostics are incomplete" }
    $recoveryMs = ([DateTimeOffset]::Parse($recovered.at) - [DateTimeOffset]::Parse($triggered.at)).TotalMilliseconds
  }
  [ordered]@{
    name = $Scenario.name
    componentCount = $Scenario.componentCount
    recovery = [bool]$Scenario.recovery
    closed = $false
    startupMs = ([DateTimeOffset]::Parse($ready.at) - $startUtc).TotalMilliseconds
    processCount = $observedIds.Count
    peakWorkingSetBytes = $peakWorkingSet
    peakCpuPercentOfMachine = [Math]::Round($peakCpuPercent, 2)
    recoveryMs = if ($null -eq $recoveryMs) { $null } else { [Math]::Round($recoveryMs, 2) }
    managerExitCode = $script:performanceProcess.ExitCode
  }
}

try {
  New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
  $scenarios = @(
    [pscustomobject]@{ name = 'manager-closed'; componentCount = 0; recovery = $false; closed = $true }
    [pscustomobject]@{ name = 'manager-open'; componentCount = 0; recovery = $false; closed = $false }
    [pscustomobject]@{ name = 'one-component'; componentCount = 1; recovery = $false; closed = $false }
    [pscustomobject]@{ name = 'two-components'; componentCount = 2; recovery = $false; closed = $false }
    [pscustomobject]@{ name = 'renderer-recovery'; componentCount = 1; recovery = $true; closed = $false }
  )
  $results = @()
  foreach ($scenario in $scenarios) {
    $results += Measure-Scenario $scenario
    Start-Sleep -Milliseconds 400
  }
  $report = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    electronVersion = (Get-Content package.json -Raw | ConvertFrom-Json).devDependencies.electron
    logicalCores = [Environment]::ProcessorCount
    sampleSeconds = $SampleSeconds
    scenarios = $results
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $outputFile) -Force | Out-Null
  Write-Utf8NoBom $outputFile (($report | ConvertTo-Json -Depth 10))
  $success = $true
  Write-Host "PASS performance smoke; report written to $outputFile"
  $results | ForEach-Object { Write-Host ("{0}: {1} processes, {2} MB peak working set, {3}% peak CPU, startup {4} ms" -f $_.name, $_.processCount, [Math]::Round($_.peakWorkingSetBytes / 1MB, 1), $_.peakCpuPercentOfMachine, [Math]::Round($_.startupMs, 0)) }
} catch {
  Write-Error $_
  Write-Host "Smoke artifacts retained at: $smokeRoot"
  exit 1
} finally {
  if ($script:performanceProcess -and -not $script:performanceProcess.HasExited) { Stop-Process -Id $script:performanceProcess.Id -Force -ErrorAction SilentlyContinue }
  $env:WIDGET_M1_CONFIG_PATH = $oldConfigPath
  $env:WIDGET_M1_REPORT = $oldReportPath
  $env:WIDGET_M1_AUTO_EXIT_MS = $oldAutoExit
  $env:WIDGET_M1_TEST_RENDERER_CRASH_MS = $oldCrashDelay
  $env:WIDGET_M1_TEST_RENDERER_CRASH_INSTANCE = $oldCrashInstance
  if ($success -and (Test-Path -LiteralPath $smokeRoot)) { Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

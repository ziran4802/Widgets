[CmdletBinding()]
param(
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputRoot)) { $OutputRoot = Join-Path $projectRoot 'dist\Widget-portable' }
if ([System.IO.Path]::IsPathRooted($OutputRoot)) {
  $outputPath = [System.IO.Path]::GetFullPath($OutputRoot)
} else {
  $outputPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputRoot))
}
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
if (-not $outputPath.StartsWith($distRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputRoot must stay under $distRoot"
}

$electronDist = Join-Path $projectRoot 'node_modules\electron\dist'
$packagePath = Join-Path $projectRoot 'package.json'
$projectLicensePath = Join-Path $projectRoot 'LICENSE'
$sourceRoot = Join-Path $projectRoot 'src'
$koffiRoot = Join-Path $projectRoot 'node_modules\koffi'
foreach ($required in @($electronDist, $packagePath, $projectLicensePath, $sourceRoot)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required packaging input is missing: $required" }
}

if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Recurse -Force }
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
Copy-Item -Path (Join-Path $electronDist '*') -Destination $outputPath -Recurse -Force

$electronExe = Join-Path $outputPath 'electron.exe'
if (-not (Test-Path -LiteralPath $electronExe)) { throw 'Electron runtime did not contain electron.exe' }
$electronLicensePaths = @(
  (Join-Path $outputPath 'LICENSE'),
  (Join-Path $outputPath 'LICENSES.chromium.html')
)
foreach ($licensePath in $electronLicensePaths) {
  if (-not (Test-Path -LiteralPath $licensePath)) { throw "Electron license notice is missing: $licensePath" }
}
Rename-Item -LiteralPath $electronExe -NewName 'Widget.exe'
$widgetExe = Join-Path $outputPath 'Widget.exe'
$iconScript = Join-Path $projectRoot 'tools\create-widget-icon.js'
$iconUpdater = Join-Path $projectRoot 'tools\widget-exe-icon.cs'
$temporaryIcon = Join-Path ([System.IO.Path]::GetTempPath()) ('Widget-icon-' + [guid]::NewGuid().ToString('N') + '.ico')
try {
  & node.exe $iconScript $temporaryIcon
  if ($LASTEXITCODE -ne 0) { throw "Widget ICO generation failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $temporaryIcon)) { throw 'Widget ICO generation did not create an output file' }
  Add-Type -Path $iconUpdater
  [WidgetExecutableIcon]::Apply($widgetExe, [System.IO.File]::ReadAllBytes($temporaryIcon))
} finally {
  if (Test-Path -LiteralPath $temporaryIcon) { Remove-Item -LiteralPath $temporaryIcon -Force -ErrorAction SilentlyContinue }
}

$appRoot = Join-Path $outputPath 'resources\app'
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
Copy-Item -LiteralPath $sourceRoot -Destination (Join-Path $appRoot 'src') -Recurse -Force
Copy-Item -LiteralPath $packagePath -Destination (Join-Path $appRoot 'package.json') -Force
Copy-Item -LiteralPath $projectLicensePath -Destination (Join-Path $appRoot 'LICENSE') -Force
if (Test-Path -LiteralPath $koffiRoot) {
  $koffiLicensePath = @('LICENSE', 'LICENSE.txt') |
    ForEach-Object { Join-Path $koffiRoot $_ } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace([string]$koffiLicensePath)) { throw "koffi license notice is missing under $koffiRoot" }
  New-Item -ItemType Directory -Path (Join-Path $appRoot 'node_modules') -Force | Out-Null
  Copy-Item -LiteralPath $koffiRoot -Destination (Join-Path $appRoot 'node_modules\koffi') -Recurse -Force
}

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$buildInfo = [ordered]@{
  name = $package.name
  version = $package.version
  electronVersion = $package.devDependencies.electron
  generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
  mode = 'portable-directory'
}
[System.IO.File]::WriteAllText((Join-Path $appRoot 'build-info.json'), ($buildInfo | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
Write-Host "PASS portable package created at $outputPath"

$ErrorActionPreference = 'Stop'
$windowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
if ([string]::IsNullOrWhiteSpace($windowsDirectory)) { throw 'Windows system directory could not be resolved' }
$compiler = Join-Path $windowsDirectory 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$output = Join-Path $PSScriptRoot 'Widget.M0.Launcher.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw "csc.exe not found: $compiler" }
& $compiler /nologo /target:winexe /out:$output (Join-Path $PSScriptRoot 'Program.cs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

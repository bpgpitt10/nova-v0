param(
  [string[]]$CaptureDir = @(),
  [string[]]$CaptureRoot = @(),
  [string]$Holes = "",
  [string]$OutputRoot = "tools\minimap_probe\output",
  [switch]$NoZip
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$Python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
  if (Get-Command py -ErrorAction SilentlyContinue) { $Python = "py" }
  elseif (Get-Command python -ErrorAction SilentlyContinue) { $Python = "python" }
  else { throw "Python was not found." }
}

$Script = Join-Path $PSScriptRoot "geometry_review_v1.py"
if (-not (Test-Path $Script)) { throw "Geometry review script missing: $Script" }

$ArgsList = @($Script, "--output-root", $OutputRoot)
foreach ($Path in $CaptureDir) { if ($Path) { $ArgsList += @("--capture-dir", $Path) } }
foreach ($Path in $CaptureRoot) { if ($Path) { $ArgsList += @("--capture-root", $Path) } }
if ($Holes) { $ArgsList += @("--holes", $Holes) }
if ($NoZip) { $ArgsList += "--no-zip" }

Write-Host "Looper 2-D Geometry Review v1"
Write-Host "OFFLINE / READ ONLY. No GSPro input. No club, bag, aim recommendation, or strategy logic."
Write-Host "Actual vs Looper reconstruction vs overlay; strategy authority OFF."
Write-Host ""
& $Python @ArgsList
exit $LASTEXITCODE

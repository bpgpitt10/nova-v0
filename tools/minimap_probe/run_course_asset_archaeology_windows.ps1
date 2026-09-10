param(
  [string]$LocalLow,
  [string]$GsproRoot,
  [string]$CourseFolder,
  [string[]]$AssetFile,
  [string]$OutputRoot = "tools\minimap_probe\output",
  [int]$RecentRounds = 25,
  [int]$MaxFiles = 50000,
  [int]$MaxObjects = 100000,
  [int]$MaxMeshExports = 200,
  [double]$MaxObjMB = 20,
  [switch]$NoMeshExport,
  [switch]$NoZip
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$VenvRoot = Join-Path $PSScriptRoot ".venv"
$Python = Join-Path $VenvRoot "Scripts\python.exe"

if (-not (Test-Path $Python)) {
  Write-Host "Creating isolated minimap-probe Python environment..."
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 -m venv $VenvRoot
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python -m venv $VenvRoot
  } else {
    throw "Python was not found."
  }
}

Write-Host "Checking Unity course-asset parser dependency..."
& $Python -c "import UnityPy" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Installing UnityPy into tools\minimap_probe\.venv..."
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements_course_assets.txt"
  if ($LASTEXITCODE -ne 0) { throw "UnityPy installation failed." }
}

$ArgsList = @(
  "tools\minimap_probe\course_asset_archaeology.py",
  "--output-root", $OutputRoot,
  "--recent-rounds", "$RecentRounds",
  "--max-files", "$MaxFiles",
  "--max-objects", "$MaxObjects",
  "--max-mesh-exports", "$MaxMeshExports",
  "--max-obj-mb", "$MaxObjMB"
)
if ($LocalLow) { $ArgsList += @("--locallow", $LocalLow) }
if ($GsproRoot) { $ArgsList += @("--gspro-root", $GsproRoot) }
if ($CourseFolder) { $ArgsList += @("--course-folder", $CourseFolder) }
if ($AssetFile) {
  foreach ($Path in $AssetFile) { $ArgsList += @("--asset-file", $Path) }
}
if ($NoMeshExport) { $ArgsList += "--no-mesh-export" }
if ($NoZip) { $ArgsList += "--no-zip" }

Write-Host ""
Write-Host "GSPro Course Asset Archaeology v0"
Write-Host "READ ONLY: no GSPro keypresses, no screen capture, no Gemini/SAM calls, no writes to course files."
Write-Host ""
& $Python @ArgsList
exit $LASTEXITCODE

param(
  [string]$LocalLow,
  [string]$GsproRoot,
  [string]$CourseFolder,
  [string[]]$GkdFile,
  [string]$OutputRoot = "tools\minimap_probe\output",
  [int]$RecentRounds = 25
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$Python = $null
$VenvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (Test-Path $VenvPython) {
  $Python = $VenvPython
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $Python = "py"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $Python = "python"
} else {
  throw "Python was not found. The later combined field-lab launcher will bootstrap dependencies; this Step 3 runner uses the existing probe Python/venv."
}

$ArgsList = @(
  "tools\minimap_probe\gkd_archaeology.py",
  "--output-root", $OutputRoot,
  "--recent-rounds", "$RecentRounds"
)
if ($LocalLow) { $ArgsList += @("--locallow", $LocalLow) }
if ($GsproRoot) { $ArgsList += @("--gspro-root", $GsproRoot) }
if ($CourseFolder) { $ArgsList += @("--course-folder", $CourseFolder) }
if ($GkdFile) {
  foreach ($Path in $GkdFile) { $ArgsList += @("--gkd-file", $Path) }
}

Write-Host "GSPro GKD Archaeology v0"
Write-Host "Read-only. No GSPro keypresses, screen capture, Gemini calls, or strategy changes."
& $Python @ArgsList
exit $LASTEXITCODE

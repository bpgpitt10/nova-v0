param(
  [string]$OutputRoot = "",
  [int]$Latest = 0,
  [double]$Corridor = 40
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"
if (-not $OutputRoot) { $OutputRoot = Join-Path $Here "output" }

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

$captures = Get-ChildItem -Path $OutputRoot -Directory -Filter "tee_capture_*" |
  Where-Object {
    (Test-Path (Join-Path $_.FullName "tee_hazard_safe_minimap.png")) -or
    (Test-Path (Join-Path $_.FullName "tee_canonical_minimap.png")) -or
    (Test-Path (Join-Path $_.FullName "tee_initial_minimap.png")) -or
    (Test-Path (Join-Path $_.FullName "watcher_prelaunch_minimap.png")) -or
    (Test-Path (Join-Path $_.FullName "tee_heatmap_minimap.png"))
  } |
  Sort-Object LastWriteTime

if ($Latest -gt 0) { $captures = $captures | Select-Object -Last $Latest }
if (-not $captures) { throw "No tee captures with saved minimap imagery found under $OutputRoot" }

Write-Host "HAZARD SHADOW REPLAY"
Write-Host "===================="
Write-Host "Captures: $($captures.Count)"
Write-Host "Bunker + water run on every image. Missing HoleModel => candidate-only mode."
Write-Host "Failures/zero detections are logged and never treated as strategy authority."
Write-Host ""

foreach ($capture in $captures) {
  Write-Host "--- $($capture.Name)"
  & $Python (Join-Path $Here "hazard_shadow_capture.py") `
    --capture-dir $capture.FullName `
    --corridor $Corridor
  # hazard_shadow_capture.py intentionally returns 0 even when an individual
  # detector fails; its JSON is the source of truth for training review.
}

Write-Host ""
Write-Host "Shadow replay complete. Review hazard_shadow_v0.json + *_shadow_* masks/overlays in each tee folder."
exit 0

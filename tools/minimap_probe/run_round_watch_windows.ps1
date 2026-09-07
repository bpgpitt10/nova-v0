param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [double]$PollMs = 250,
  [string]$UpperLeftShotRoi = "",
  [string]$UpperLeftDistanceRoi = "",
  [switch]$ExecuteActions,
  [switch]$Json,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

if (($UpperLeftShotRoi -and -not $UpperLeftDistanceRoi) -or ($UpperLeftDistanceRoi -and -not $UpperLeftShotRoi)) {
  throw "Upper-left calibration requires BOTH -UpperLeftShotRoi and -UpperLeftDistanceRoi."
}

$argsList = @(
  (Join-Path $Here "round_watch.py"),
  "--monitor", "$Monitor",
  "--poll-ms", "$PollMs"
)
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($UpperLeftShotRoi) { $argsList += @("--upper-left-shot-roi", $UpperLeftShotRoi) }
if ($UpperLeftDistanceRoi) { $argsList += @("--upper-left-distance-roi", $UpperLeftDistanceRoi) }
if ($ExecuteActions) { $argsList += "--execute-actions" }
if ($Json) { $argsList += "--json" }
if ($Once) { $argsList += "--once" }

if ($ExecuteActions) {
  Write-Warning "ROUND WATCH ACTIONS ENABLED: confirmed tee events may launch the proven tee capture script."
} else {
  Write-Host "ROUND WATCH DRY RUN: no capture scripts or GSPro keys will be triggered."
}
if ($UpperLeftShotRoi) {
  Write-Host "Upper-left shot number + DTP OCR enabled using explicit calibrated ROIs."
} else {
  Write-Host "Upper-left shot state not configured yet; no default ROI is guessed."
}
Write-Host "Post-tee transitions may be detected once upper-left OCR is configured, but automatic post-tee execution remains field-blocked."

& $Python @argsList
exit $LASTEXITCODE

param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [double]$PollMs = 250,
  [string]$UpperLeftShotRoi = "",
  [string]$UpperLeftDistanceRoi = "",
  [string]$UpperLeftElevationRoi = "",
  [string]$UpperLeftPlayerRoi = "",
  [switch]$DisableUpperLeft,
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

$argsList = @(
  (Join-Path $Here "round_watch.py"),
  "--monitor", "$Monitor",
  "--poll-ms", "$PollMs"
)
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($UpperLeftShotRoi) { $argsList += @("--upper-left-shot-roi", $UpperLeftShotRoi) }
if ($UpperLeftDistanceRoi) { $argsList += @("--upper-left-distance-roi", $UpperLeftDistanceRoi) }
if ($UpperLeftElevationRoi) { $argsList += @("--upper-left-elevation-roi", $UpperLeftElevationRoi) }
if ($UpperLeftPlayerRoi) { $argsList += @("--upper-left-player-roi", $UpperLeftPlayerRoi) }
if ($DisableUpperLeft) { $argsList += "--disable-upper-left" }
if ($ExecuteActions) { $argsList += "--execute-actions" }
if ($Json) { $argsList += "--json" }
if ($Once) { $argsList += "--once" }

if ($ExecuteActions) {
  Write-Warning "ROUND WATCH ACTIONS ENABLED: confirmed tee events may launch the proven tee capture script."
} else {
  Write-Host "ROUND WATCH DRY RUN: no capture scripts or GSPro keys will be triggered."
}
if ($DisableUpperLeft) {
  Write-Host "Upper-left HUD reader DISABLED by request."
} else {
  Write-Host "Upper-left HUD reader ENABLED with calibrated normalized defaults."
  Write-Host "Reads player + shot number + decimal DTP + signed elevation."
}
Write-Host "Post-tee transitions are detected from shot-number advancement; automatic post-tee execution remains field-blocked."

& $Python @argsList
exit $LASTEXITCODE

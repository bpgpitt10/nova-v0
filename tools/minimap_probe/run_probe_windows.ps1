param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$LieRoi = "",
  [string]$Tesseract = "",
  [string]$HeatmapKey = "Y",
  [double]$HeatmapSettleMs = 320,
  [double]$HeatmapPulseMs = 45,
  [double]$AimPulseMs = 45,
  [double]$AimSettleMs = 180,
  [double]$AimReturnTolerancePx = 1.5,
  [double]$AimMaxCorrectionMs = 20,
  [int]$AimMaxCorrections = 2,
  [switch]$NoAimSummon
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
  (Join-Path $Here "probe_v8.py"),
  "--monitor", "$Monitor",
  "--heatmap-key", "$HeatmapKey",
  "--heatmap-settle-ms", "$HeatmapSettleMs",
  "--heatmap-pulse-ms", "$HeatmapPulseMs",
  "--aim-pulse-ms", "$AimPulseMs",
  "--aim-settle-ms", "$AimSettleMs",
  "--aim-return-tolerance-px", "$AimReturnTolerancePx",
  "--aim-max-correction-ms", "$AimMaxCorrectionMs",
  "--aim-max-corrections", "$AimMaxCorrections"
)

if ($Roi) {
  $argsList += @("--roi", $Roi)
}

if ($LieRoi) {
  $argsList += @("--lie-roi", $LieRoi)
}

if ($Tesseract) {
  $argsList += @("--tesseract", $Tesseract)
}

if ($NoAimSummon) {
  $argsList += "--no-aim-summon"
}

if ($HeatmapKey -notin @("Y", "y")) {
  throw "-HeatmapKey must be Y for the current GSPro heatmap capture contract."
}

Write-Host "Running GSPro tee-capture orchestrator v8 once."
Write-Host "TEE RULE: minimap zoom is never changed; W recovery is disabled by design."
Write-Host "Screen PIN distance/elevation + minimap directional lie enabled."
Write-Host "Heatmap sequence: initial capture -> Y toggle -> registered capture -> Y restore."
Write-Host "One canonical HEATMAP-ON minimap is written to the HoleModel."
Write-Host "Red penalty CV restores only Y-changed green pixels transiently to avoid heatmap contamination."
if ($NoAimSummon) {
  Write-Host "Automatic AIM-card summon disabled."
} else {
  Write-Host "AIM acquisition runs after heatmap restoration with controlled L/R return verification."
}

& $Python @argsList

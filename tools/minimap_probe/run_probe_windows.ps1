param(
  [int]$Monitor = 1,
  [Nullable[double]]$Distance = $null,
  [string]$Roi = "",
  [string]$TargetCardRoi = "",
  [string]$LieRoi = "",
  [string]$Tesseract = "",
  [string]$ZoomOutKey = "W",
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
  (Join-Path $Here "probe_v7.py"),
  "--monitor", "$Monitor",
  "--aim-pulse-ms", "$AimPulseMs",
  "--aim-settle-ms", "$AimSettleMs",
  "--aim-return-tolerance-px", "$AimReturnTolerancePx",
  "--aim-max-correction-ms", "$AimMaxCorrectionMs",
  "--aim-max-corrections", "$AimMaxCorrections"
)

# Manual distance remains only a debugging fallback/override. Normal live use
# reads distance/elevation from GSPro's white PIN target card.
if ($Distance -ne $null) {
  $argsList += @("--distance", "$Distance")
}

if ($Roi) {
  $argsList += @("--roi", $Roi)
}

if ($TargetCardRoi) {
  $argsList += @("--target-card-roi", $TargetCardRoi)
}

if ($LieRoi) {
  $argsList += @("--lie-roi", $LieRoi)
}

if ($Tesseract) {
  $argsList += @("--tesseract", $Tesseract)
}

if ($ZoomOutKey) {
  if ($ZoomOutKey -notin @("W", "w")) {
    throw "-ZoomOutKey must be W (GSPro zoom out)."
  }
  $argsList += @("--zoom-out-key", $ZoomOutKey)
}

if ($NoAimSummon) {
  $argsList += "--no-aim-summon"
}

Write-Host "Running GSPro live-state + minimap hazard probe v7 once."
Write-Host "White PIN + player-color AIM target-card detection enabled."
Write-Host "Screen PIN card is primary for distance + elevation."
Write-Host "Directional lie OCR enabled from minimap footer (UP/DOWN + LEFT/RIGHT)."
if ($NoAimSummon) {
  Write-Host "Automatic AIM-card summon disabled."
} else {
  Write-Host "Automatic AIM-card summon enabled: controlled L/R pulse with visual return verification."
  Write-Host "Aim pulse: $AimPulseMs ms each direction; return tolerance: $AimReturnTolerancePx px."
}
Write-Host "Fixed-size player detection + label-occlusion tolerant hazard crossings enabled."
if ($Distance -ne $null) {
  Write-Host "Manual distance override supplied: $Distance yd"
}
if ($ZoomOutKey) {
  Write-Host "Automatic zoom-out recovery enabled with key: $ZoomOutKey (view is left zoomed out)."
}

& $Python @argsList

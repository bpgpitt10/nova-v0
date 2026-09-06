param(
  [int]$Monitor = 1,
  [Nullable[double]]$Distance = $null,
  [string]$Roi = "",
  [string]$TargetCardRoi = "",
  [string]$Tesseract = "",
  [string]$ZoomOutKey = "W"
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
  (Join-Path $Here "probe_v6.py"),
  "--monitor", "$Monitor"
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

if ($Tesseract) {
  $argsList += @("--tesseract", $Tesseract)
}

if ($ZoomOutKey) {
  if ($ZoomOutKey -notin @("W", "w")) {
    throw "-ZoomOutKey must be W (GSPro zoom out)."
  }
  $argsList += @("--zoom-out-key", $ZoomOutKey)
}

Write-Host "Running GSPro live-state + minimap hazard probe v6 once."
Write-Host "White PIN + player-color AIM target-card detection enabled."
Write-Host "Screen PIN card is primary for distance + elevation."
Write-Host "Fixed-size player detection + label-occlusion tolerant hazard crossings enabled."
if ($Distance -ne $null) {
  Write-Host "Manual distance override supplied: $Distance yd"
}
if ($ZoomOutKey) {
  Write-Host "Automatic zoom-out recovery enabled with key: $ZoomOutKey (view is left zoomed out)."
}

& $Python @argsList

param(
  [int]$Monitor = 1,
  [Nullable[double]]$Distance = $null,
  [string]$Roi = "",
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

if ($Distance -eq $null) {
  throw "v2 probe requires -Distance <current GSPro distance to pin>."
}

$argsList = @(
  (Join-Path $Here "probe_v2.py"),
  "--monitor", "$Monitor",
  "--distance", "$Distance"
)

if ($Roi) {
  $argsList += @("--roi", $Roi)
}

if ($ZoomOutKey) {
  if ($ZoomOutKey -notin @("Q", "W", "q", "w")) {
    throw "-ZoomOutKey must be Q or W."
  }
  $argsList += @("--zoom-out-key", $ZoomOutKey)
}

Write-Host "Running GSPro minimap hazard probe v2 once."
if ($ZoomOutKey) {
  Write-Host "Automatic zoom recovery enabled with key: $ZoomOutKey"
  Write-Host "If recovery zooms out, the broader map view is intentionally left in place."
}

& $Python @argsList

param(
  [double]$WatchSeconds = 2.0,
  [int]$Monitor = 1,
  [Nullable[double]]$Distance = $null,
  [string]$Roi = ""
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
  (Join-Path $Here "probe.py"),
  "--watch", "$WatchSeconds",
  "--monitor", "$Monitor"
)

if ($Distance -ne $null) {
  $argsList += @("--distance", "$Distance")
}

if ($Roi) {
  $argsList += @("--roi", $Roi)
}

Write-Host "Starting GSPro minimap probe. Ctrl+C to stop."
& $Python @argsList

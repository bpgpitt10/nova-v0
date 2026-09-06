param(
  [Nullable[double]]$WatchSeconds = $null,
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
  (Join-Path $Here "probe_v2.py"),
  "--monitor", "$Monitor"
)

if ($WatchSeconds -ne $null) {
  $argsList += @("--watch", "$WatchSeconds")
}

if ($Distance -ne $null) {
  $argsList += @("--distance", "$Distance")
}

if ($Roi) {
  $argsList += @("--roi", $Roi)
}

if ($WatchSeconds -ne $null) {
  Write-Host "Starting GSPro minimap probe in watch mode. Ctrl+C to stop."
} else {
  Write-Host "Running GSPro minimap probe once."
}

& $Python @argsList

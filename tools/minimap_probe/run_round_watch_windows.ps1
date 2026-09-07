param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [double]$PollMs = 250,
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
if ($ExecuteActions) { $argsList += "--execute-actions" }
if ($Json) { $argsList += "--json" }
if ($Once) { $argsList += "--once" }

if ($ExecuteActions) {
  Write-Warning "ROUND WATCH ACTIONS ENABLED: confirmed tee events may launch the tee capture script."
} else {
  Write-Host "ROUND WATCH DRY RUN: no capture scripts or GSPro keys will be triggered."
}
Write-Host "Automatic post-tee capture remains blocked until upper-left shot-number OCR is calibrated."

& $Python @argsList
exit $LASTEXITCODE

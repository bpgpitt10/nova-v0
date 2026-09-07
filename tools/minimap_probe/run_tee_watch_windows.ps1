param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [double]$PollMs = 250,
  [int]$StableObservations = 2,
  [switch]$Once,
  [switch]$Json
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
  (Join-Path $Here "tee_watch.py"),
  "--monitor", "$Monitor",
  "--poll-ms", "$PollMs",
  "--stable-observations", "$StableObservations"
)
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($Once) { $argsList += "--once" }
if ($Json) { $argsList += "--json" }

Write-Host "Starting READ-ONLY GSPro automatic tee watcher."
Write-Host "This diagnostic never presses W, Y, LEFT or RIGHT and never launches tee capture."
Write-Host "It uses the minimap Tee/Fairway title plus upper-right course/hole identity."
Write-Host "Ctrl+C to stop."

& $Python @argsList
exit $LASTEXITCODE

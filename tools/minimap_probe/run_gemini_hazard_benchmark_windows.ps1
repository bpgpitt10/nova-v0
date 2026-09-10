param(
  [string]$OutputRoot = "",
  [int]$Latest = 5,
  [string]$Models = "gemini-3.7-flash,gemini-3.1-flash-lite",
  [int]$Repeats = 1,
  [double]$TimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutputRoot) { $OutputRoot = Join-Path $Here "output" }
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not $env:GEMINI_API_KEY) {
  throw "GEMINI_API_KEY is not visible in this PowerShell process. Close/reopen PowerShell after setting it."
}
Write-Host "Gemini key detected (value will not be printed)."

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

Write-Host ""
Write-Host "LOOPER GEMINI HAZARD BENCHMARK"
Write-Host "=============================="
Write-Host "Models:   $Models"
Write-Host "Captures: latest $Latest saved tee captures"
Write-Host "Repeats:  $Repeats"
Write-Host "SAFE: diagnostic shadow only. No GSPro actuation. No strategy authority."
Write-Host ""

& $Python (Join-Path $Here "hazard_vlm_gemini_benchmark.py") `
  --output-root $OutputRoot `
  --latest $Latest `
  --models $Models `
  --repeats $Repeats `
  --timeout-seconds $TimeoutSeconds

exit $LASTEXITCODE

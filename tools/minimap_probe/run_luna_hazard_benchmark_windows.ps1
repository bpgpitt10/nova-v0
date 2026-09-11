param(
  [int]$Latest = 5,
  [int]$Repeats = 1,
  [double]$TimeoutSeconds = 60,
  [switch]$GeminiFallback
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

if (-not $env:OPENAI_API_KEY) {
  throw "OPENAI_API_KEY is not set in this PowerShell session."
}

$argsList = @(
  (Join-Path $Here "hazard_vlm_provider_benchmark.py"),
  "--latest", "$Latest",
  "--repeats", "$Repeats",
  "--timeout-seconds", "$TimeoutSeconds"
)
if ($GeminiFallback) { $argsList += "--gemini-fallback" }

Write-Host "Looper Hazard VLM Benchmark - Luna first"
Write-Host "Saved tee captures only. No live strategy authority."
Write-Host "Primary: gpt-5.6-luna"
if ($GeminiFallback) { Write-Host "Fallback: gemini-3.1-flash-lite" }

& $Python @argsList
exit $LASTEXITCODE

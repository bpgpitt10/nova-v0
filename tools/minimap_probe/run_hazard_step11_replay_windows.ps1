param(
  [int]$TeeLimit = 4,
  [int]$ApproachLimit = 12,
  [switch]$NoLunaRerun
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

# A fresh PowerShell may not have inherited a key saved during an older shell.
if (-not $env:OPENAI_API_KEY) {
  $env:OPENAI_API_KEY = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "User")
}

$argsList = @(
  (Join-Path $Here "hazard_step11_replay_v2.py"),
  "--tee-limit", "$TeeLimit",
  "--approach-limit", "$ApproachLimit"
)
if (-not $NoLunaRerun) {
  $argsList += "--rerun-luna"
}

Write-Host "Running saved Step 11 evidence only. GSPro actuation: NONE."
& $Python @argsList

param(
  [string]$CaptureDir = "",
  [double]$TimeoutSeconds = 60,
  [switch]$AllowUnconfirmedSemanticImage
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
  Write-Host "LUNA STEP 11 PREFLIGHT: FAIL"
  Write-Host "OPENAI_API_KEY is not set in this PowerShell session."
  exit 1
}

$argsList = @(
  (Join-Path $Here "hazard_luna_preflight.py"),
  "--timeout-seconds", "$TimeoutSeconds"
)
if ($CaptureDir) { $argsList += @("--capture-dir", $CaptureDir) }
if ($AllowUnconfirmedSemanticImage) { $argsList += "--allow-unconfirmed-semantic-image" }

Write-Host "Looper Luna Step 11 preflight"
Write-Host "Saved tee image only. GSPro actuation: NONE. Strategy authority: OFF."
& $Python @argsList
exit $LASTEXITCODE

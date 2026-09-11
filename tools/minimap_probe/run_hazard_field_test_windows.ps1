param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [string]$GsproDir = "",
  [double]$ShadowSettleSeconds = 20,
  [double]$MaxFileMb = 8,
  [double]$MaxTotalMb = 80,
  [switch]$NoAimDebug,
  [switch]$DryRun
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
  (Join-Path $Here "hazard_field_run.py"),
  "--monitor", "$Monitor",
  "--shadow-settle-seconds", "$ShadowSettleSeconds",
  "--max-file-mb", "$MaxFileMb",
  "--max-total-mb", "$MaxTotalMb"
)

if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($GsproDir) { $argsList += @("--gspro-dir", $GsproDir) }
if ($NoAimDebug) { $argsList += "--no-aim-debug" }
if ($DryRun) { $argsList += "--dry-run" }

Write-Host "Looper Hazard Field Test - Step 11"
Write-Host "FIELD-LAB VALIDATION ONLY. Production remains hosted looper.golf; this is not a packaged-app dependency."
Write-Host "One run: start -> play GSPro normally -> Ctrl+C -> bounded evidence ZIP + Step 10 report."
Write-Host "Strategy authority: OFF | Promotion: NONE"

& $Python @argsList
exit $LASTEXITCODE

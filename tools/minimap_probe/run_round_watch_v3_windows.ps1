param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [string]$GsproDir = "",
  [double]$PollMs = 350,
  [double]$PostteeMinSettleMs = 850,
  [double]$CaptureRetryMs = 1100,
  [int]$MaxCaptureAttempts = 2,
  [int]$TransitionStableObservations = 2,
  [switch]$DryRun,
  [switch]$Resume,
  [switch]$NoAimDebug,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $Here "..\..")).Path
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"
$StateFile = Join-Path $Here "output\round_watch_state_v3.json"

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

if (-not $Resume -and (Test-Path $StateFile)) {
  Remove-Item $StateFile -Force
}

$argsList = @(
  (Join-Path $Here "round_watch_v3.py"),
  "--monitor", "$Monitor",
  "--poll-ms", "$PollMs",
  "--posttee-min-settle-ms", "$PostteeMinSettleMs",
  "--capture-retry-ms", "$CaptureRetryMs",
  "--max-capture-attempts", "$MaxCaptureAttempts",
  "--transition-stable-observations", "$TransitionStableObservations",
  "--state-file", "$StateFile"
)

if (-not $DryRun) { $argsList += "--execute-actions" }
if ($Resume) { $argsList += "--resume" }
if ($NoAimDebug) { $argsList += "--no-aim-debug" }
if ($Once) { $argsList += "--once" }
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($GsproDir) { $argsList += @("--gspro-dir", $GsproDir) }

Write-Host "Looper watcher v3.1"
if ($DryRun) {
  Write-Host "MODE: DRY RUN - lifecycle/evidence only; no capture actions."
} else {
  Write-Host "MODE: ACTIVE CAPTURE"
}
Write-Host "No auto aim. No extra aim calibration pulses. W disabled."
Write-Host "Structured next-hole state outranks OCR; screen gates capture readiness."
Write-Host "Post-tee geometry is bound to the exact current-hole tee HoleModel."
Write-Host "Ctrl+C stops cleanly."

Push-Location $RepoRoot
try {
  & $Python @argsList
  exit $LASTEXITCODE
} finally {
  Pop-Location
}

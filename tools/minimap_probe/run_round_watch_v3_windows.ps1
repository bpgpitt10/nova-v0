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
  [double]$LogHoleFreshSeconds = 3.0,
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
  (Join-Path $Here "round_watch_v33.py"),
  "--monitor", "$Monitor",
  "--poll-ms", "$PollMs",
  "--posttee-min-settle-ms", "$PostteeMinSettleMs",
  "--capture-retry-ms", "$CaptureRetryMs",
  "--max-capture-attempts", "$MaxCaptureAttempts",
  "--transition-stable-observations", "$TransitionStableObservations",
  "--log-hole-fresh-seconds", "$LogHoleFreshSeconds",
  "--state-file", "$StateFile"
)

if (-not $DryRun) { $argsList += "--execute-actions" }
if ($Resume) { $argsList += "--resume" }
if ($NoAimDebug) { $argsList += "--no-aim-debug" }
if ($Once) { $argsList += "--once" }
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($GsproDir) { $argsList += @("--gspro-dir", $GsproDir) }

Write-Host "Looper watcher v3.3 policy layer (v3.2/v3.1 engine)"
if ($DryRun) {
  Write-Host "MODE: DRY RUN - lifecycle/evidence only; no capture actions."
} else {
  Write-Host "MODE: ACTIVE CAPTURE"
}
Write-Host "DB ActiveHole: diagnostic only (field-proven stale)."
Write-Host "Next hole: AllPlayersHoledOut -> expect N+1 -> Shot 1 + Tee can confirm."
Write-Host "Post-shot DistanceToPin: currentRound meters -> yards, used to validate/fallback PIN OCR."
Write-Host "Tee capture: verified Y state + inside-child tee-race guard."
Write-Host "Post-tee AIM: passive minimap marker first; prior bounded card summon/return only as fallback."
Write-Host "Exact per-hole HoleModel binding. No strategy auto-aim. W disabled."
Write-Host "Ctrl+C stops cleanly."

Push-Location $RepoRoot
try {
  & $Python @argsList
  exit $LASTEXITCODE
} finally {
  Pop-Location
}

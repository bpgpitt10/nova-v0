param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [int]$PollMs = 500,
  [switch]$DryRun,
  [switch]$Resume
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"
$StateFile = Join-Path $Here "output\round_watch_state.json"

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

if (-not $Resume -and (Test-Path $StateFile)) {
  Remove-Item -Path $StateFile -Force
}

$argsList = @(
  (Join-Path $Here "round_watch.py"),
  "--monitor", "$Monitor",
  "--poll-ms", "$PollMs",
  "--state-file", "$StateFile"
)
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($Resume) { $argsList += "--resume" }
if (-not $DryRun) { $argsList += "--execute-actions" }

Write-Host "Looper GSPro persistent minimap watcher"
Write-Host ""
if ($DryRun) {
  Write-Host "MODE: DRY RUN - watcher will detect transitions but launch no capture scripts."
} else {
  Write-Host "MODE: CAPTURE ACTIVE - one launch is intended to cover several holes."
}
if ($Resume) {
  Write-Host "SESSION: resuming saved watcher state."
} else {
  Write-Host "SESSION: fresh watcher state."
}
Write-Host "TEE: proven v8 HoleModel capture; Y restored; W disabled."
Write-Host "POST-TEE: v1 canonical geometry + green visibility dry run; NO W; NO Y."
Write-Host "Tee review ZIP creation is suppressed during the round; raw capture artifacts are retained."
Write-Host "Ctrl+C stops cleanly and saves watcher state."
Write-Host ""

& $Python @argsList
exit $LASTEXITCODE

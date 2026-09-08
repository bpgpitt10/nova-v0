param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [double]$FilePollMs = 60,
  [double]$DbPollMs = 100,
  [double]$ScreenPollMs = 500,
  [double]$ScreenHeartbeatSeconds = 5,
  [switch]$NoScreen,
  [double]$DurationSeconds = 0
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
  (Join-Path $Here "gspro_event_probe.py"),
  "--monitor", "$Monitor",
  "--file-poll-ms", "$FilePollMs",
  "--db-poll-ms", "$DbPollMs",
  "--screen-poll-ms", "$ScreenPollMs",
  "--screen-heartbeat-seconds", "$ScreenHeartbeatSeconds"
)
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($NoScreen) { $argsList += "--no-screen" }
if ($DurationSeconds -gt 0) { $argsList += @("--duration-seconds", "$DurationSeconds") }

Write-Host "Looper GSPro PASSIVE EVENT PROBE"
Write-Host "================================"
Write-Host "This probe presses NO GSPro keys and launches NO capture actions."
Write-Host "It only observes currentRound.dat, output_log.txt, GSPro.db, and the screen."
Write-Host "Play normally. Press Ctrl+C when finished; the probe will save a ZIP."
Write-Host ""

& $Python @argsList
exit $LASTEXITCODE

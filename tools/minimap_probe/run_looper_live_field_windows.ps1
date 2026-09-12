param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [string]$GsproDir = "",
  [switch]$NoStatus
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $Here "..\..")).Path
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"
$Watcher = Join-Path $Here "run_round_watch_v3_windows.ps1"
$StatusScript = Join-Path $Here "hazard_live_status.py"
$OutputRoot = Join-Path $Here "output"

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

# Rehydrate the user's saved API key into this shell if needed. Never print it.
if (-not $env:OPENAI_API_KEY) {
  $SavedKey = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "User")
  if ($SavedKey) { $env:OPENAI_API_KEY = $SavedKey }
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host " LOOPER LIVE FIELD BUILD" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host "Play GSPro normally."
Write-Host "Tee: resilient HoleModel + verified Y + Luna/SAM shadow hazards."
Write-Host "After shots: PIN/lie/geometry + passive AIM first; bounded fallback only if needed."
Write-Host "No W. No strategy auto-aim. Ctrl+C stops cleanly."
if ($env:OPENAI_API_KEY) {
  Write-Host "Luna: READY" -ForegroundColor Green
} else {
  Write-Warning "OPENAI_API_KEY not available in this shell. Geometry capture will still run; Luna will fail-soft."
}
Write-Host ""

$StatusProcess = $null
if (-not $NoStatus -and (Test-Path $StatusScript)) {
  try {
    $StatusArgs = @($StatusScript, "--output-root", $OutputRoot)
    $StatusProcess = Start-Process -FilePath $Python -ArgumentList $StatusArgs -WorkingDirectory $RepoRoot -NoNewWindow -PassThru
  } catch {
    Write-Warning "Live status monitor could not start; watcher will continue: $($_.Exception.Message)"
  }
}

$WatcherArgs = @("-Monitor", "$Monitor")
if ($Roi) { $WatcherArgs += @("-Roi", $Roi) }
if ($Tesseract) { $WatcherArgs += @("-Tesseract", $Tesseract) }
if ($GsproDir) { $WatcherArgs += @("-GsproDir", $GsproDir) }

Push-Location $RepoRoot
try {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $Watcher @WatcherArgs
  exit $LASTEXITCODE
} finally {
  if ($StatusProcess -and -not $StatusProcess.HasExited) {
    try { Stop-Process -Id $StatusProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  Pop-Location
}

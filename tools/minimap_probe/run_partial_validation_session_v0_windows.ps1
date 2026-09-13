param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [int]$PollMs = 500
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Looper Greywolf partial validation v0"
Write-Host ""
Write-Host "1. Start GSPro on the course you want to validate."
Write-Host "2. Play about 5 holes normally. Do not manufacture shots."
Write-Host "3. Press Ctrl+C ONCE when finished. The watcher should save state and return here."
Write-Host "4. This launcher will then package the same watcher session automatically."
Write-Host ""
Write-Host "Validation only: no recommendation authority, no auto aim, no W zoom, no post-tee Y toggle."
Write-Host ""

$WatchArgs = @(
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $Here "run_round_watch_windows.ps1"),
  "-Monitor", "$Monitor",
  "-PollMs", "$PollMs"
)
if ($Roi) { $WatchArgs += @("-Roi", $Roi) }
if ($Tesseract) { $WatchArgs += @("-Tesseract", $Tesseract) }

try {
  & powershell @WatchArgs
  $WatchExit = $LASTEXITCODE
} catch {
  Write-Warning "Watcher returned through PowerShell interruption: $($_.Exception.Message)"
  $WatchExit = 0
}

Write-Host ""
Write-Host "Watcher ended. Packaging that session now..."

$PackageScript = Join-Path $Here "run_package_partial_validation_v0_windows.ps1"
& powershell -ExecutionPolicy Bypass -File $PackageScript
if ($LASTEXITCODE -ne 0) {
  throw "Partial-validation packaging failed. Watcher exit code was $WatchExit."
}

$Latest = Join-Path $Here "output\latest_partial_validation.zip"
Write-Host ""
Write-Host "UPLOAD THIS ONE FILE: $Latest"
Write-Host ""
Write-Host "If Ctrl+C terminated this launcher before packaging, run only:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\tools\minimap_probe\run_package_partial_validation_v0_windows.ps1"
exit 0

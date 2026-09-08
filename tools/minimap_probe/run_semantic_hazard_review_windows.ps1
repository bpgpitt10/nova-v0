param(
  [string]$CaptureDir = "",
  [double]$Corridor = 40
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$bunkerArgs = @("-Corridor", "$Corridor")
$waterArgs = @("-Corridor", "$Corridor")
if ($CaptureDir) {
  $bunkerArgs += @("-CaptureDir", $CaptureDir)
  $waterArgs += @("-CaptureDir", $CaptureDir)
}

Write-Host ""
Write-Host "SEMANTIC HAZARD REVIEW"
Write-Host "======================"
Write-Host "SAFE: saved tee captures only; no GSPro input or HoleModel mutation."
Write-Host ""

& powershell -ExecutionPolicy Bypass -File (Join-Path $Here "run_bunker_probe_windows.ps1") @bunkerArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
& powershell -ExecutionPolicy Bypass -File (Join-Path $Here "run_water_probe_windows.ps1") @waterArgs
exit $LASTEXITCODE

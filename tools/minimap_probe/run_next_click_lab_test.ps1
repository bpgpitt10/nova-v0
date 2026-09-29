param(
  [switch]$Click
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $Here "run_click_lab_windows.ps1"

if ($Click) {
  Write-Host "NEXT CLICK LAB TEST: +10 yd right / 200 yd forward / ONE CLICK"
  & $Runner -Right 10 -Forward 200 -Click
} else {
  Write-Host "NEXT CLICK LAB TEST: +10 yd right / 200 yd forward / PREVIEW ONLY"
  Write-Host "Running deterministic transform and marker proofs first."
  & $Runner -Right 10 -Forward 200 -RunProof
}

exit $LASTEXITCODE

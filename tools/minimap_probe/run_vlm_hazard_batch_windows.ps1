param(
  [string]$OutputRoot = "",
  [int]$Latest = 0
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutputRoot) { $OutputRoot = Join-Path $Here "output" }
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

$captures = Get-ChildItem -Path $OutputRoot -Directory -Filter "tee_capture_*" |
  Sort-Object LastWriteTime

if ($Latest -gt 0) {
  $captures = $captures | Select-Object -Last $Latest
}

if (-not $captures) {
  throw "No tee_capture_* directories found under $OutputRoot"
}

Write-Host ""
Write-Host "VLM HAZARD SHADOW BATCH"
Write-Host "======================="
Write-Host "Creates provider-neutral VLM request artifacts for every saved tee."
Write-Host "If hazard_vlm_response_v0.json exists, validates and refines it locally."
Write-Host "SAFE: offline/read-only with respect to GSPro; strategy authority remains OFF."
Write-Host ""

$failed = 0
foreach ($capture in $captures) {
  Write-Host "------------------------------------------------------------"
  Write-Host $capture.Name
  & $Python (Join-Path $Here "hazard_vlm_shadow.py") --capture-dir $capture.FullName
  if ($LASTEXITCODE -ne 0) {
    $failed += 1
    Write-Warning "VLM shadow failed for $($capture.FullName)"
  }
}

Write-Host ""
Write-Host "Batch complete: $($captures.Count - $failed) succeeded; $failed failed."
if ($failed -gt 0) { exit 1 }
exit 0

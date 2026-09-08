param(
  [string]$OutputRoot = "",
  [double]$Corridor = 40,
  [int]$Latest = 0
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutputRoot) { $OutputRoot = Join-Path $Here "output" }

$captures = Get-ChildItem -Path $OutputRoot -Directory -Filter "tee_capture_*" |
  Where-Object { Test-Path (Join-Path $_.FullName "hole_model.json") } |
  Sort-Object LastWriteTime

if ($Latest -gt 0) {
  $captures = $captures | Select-Object -Last $Latest
}

if (-not $captures) {
  throw "No tee_capture_* directories with hole_model.json found under $OutputRoot"
}

Write-Host ""
Write-Host "SEMANTIC HAZARD BATCH REVIEW"
Write-Host "============================"
Write-Host "Captures: $($captures.Count)"
Write-Host "SAFE: offline/read-only; no GSPro input or canonical HoleModel mutation."
Write-Host ""

$failed = 0
foreach ($capture in $captures) {
  Write-Host "------------------------------------------------------------"
  Write-Host $capture.Name
  & powershell -ExecutionPolicy Bypass -File (Join-Path $Here "run_semantic_hazard_review_windows.ps1") `
      -CaptureDir $capture.FullName -Corridor $Corridor
  if ($LASTEXITCODE -ne 0) {
    $failed += 1
    Write-Warning "Review failed for $($capture.FullName)"
  }
}

Write-Host ""
Write-Host "Batch complete: $($captures.Count - $failed) succeeded; $failed failed."
if ($failed -gt 0) { exit 1 }
exit 0

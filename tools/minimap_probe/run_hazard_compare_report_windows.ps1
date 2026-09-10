param(
  [string[]]$CaptureRoot = @(),
  [string[]]$Bundle = @(),
  [string[]]$CurrentRound = @(),
  [string]$LocalLow = "",
  [double]$IouThreshold = 0.10,
  [double]$NearTolerance = 3.0,
  [switch]$NoZip
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPython = Join-Path $Here ".venv\Scripts\python.exe"
$Python = if (Test-Path $VenvPython) { $VenvPython } else { "python" }
$Script = Join-Path $Here "hazard_compare_report.py"

if (-not (Test-Path $Script)) {
  throw "Step 10 comparison script missing: $Script"
}

# This runner deliberately installs nothing. The report uses the existing field-lab
# environment when present and otherwise falls back to the user's system Python.
$argsList = @(
  $Script,
  "--iou-threshold", "$IouThreshold",
  "--near-tolerance", "$NearTolerance"
)
foreach ($value in $CaptureRoot) { if ($value) { $argsList += @("--capture-root", $value) } }
foreach ($value in $Bundle) { if ($value) { $argsList += @("--bundle", $value) } }
foreach ($value in $CurrentRound) { if ($value) { $argsList += @("--current-round", $value) } }
if ($LocalLow) { $argsList += @("--locallow", $LocalLow) }
if ($NoZip) { $argsList += "--no-zip" }

Write-Host "Looper Hazard Comparison Step 10"
Write-Host "READ-ONLY EVIDENCE MODE. Strategy authority OFF. Promotion NONE."
Write-Host "No packages will be installed by this runner."
& $Python @argsList
exit $LASTEXITCODE

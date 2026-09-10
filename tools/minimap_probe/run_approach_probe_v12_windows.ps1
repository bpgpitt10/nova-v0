param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$LieRoi = "",
  [string]$Tesseract = "",
  [string]$GsproDir = "",
  [double]$AimPulseMs = 45,
  [double]$AimSettleMs = 60,
  [double]$AimReturnTolerancePx = 1.5,
  [double]$AimMaxCorrectionMs = 20,
  [int]$AimMaxCorrections = 2,
  [string]$HoleModelPath = "",
  [switch]$NoCanonicalGeometry,
  [switch]$NoAimSummon,
  [switch]$DeepDebug
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
  (Join-Path $Here "probe_approach_v12.py"),
  "--monitor", "$Monitor",
  "--aim-pulse-ms", "$AimPulseMs",
  "--aim-settle-ms", "$AimSettleMs",
  "--aim-return-tolerance-px", "$AimReturnTolerancePx",
  "--aim-max-correction-ms", "$AimMaxCorrectionMs",
  "--aim-max-corrections", "$AimMaxCorrections"
)

if ($Roi) { $argsList += @("--roi", $Roi) }
if ($LieRoi) { $argsList += @("--lie-roi", $LieRoi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($GsproDir) { $argsList += @("--gspro-dir", $GsproDir) }
if ($HoleModelPath) { $argsList += @("--hole-model-path", $HoleModelPath) }
if ($NoCanonicalGeometry) { $argsList += "--no-canonical-geometry" }
if ($NoAimSummon) { $argsList += "--no-aim-summon" }
if ($DeepDebug) { $argsList += "--deep-debug" }

Write-Host "Running GSPro POST-TEE ShotState probe v1.2 once."
Write-Host "FAIL-SOFT: PIN/lie/AIM/green failures become unavailable sensors, not discarded ShotStates."
Write-Host "SAFE: no W zoom and no Y heatmap. Existing bounded AIM summon/return only."
& $Python @argsList
exit $LASTEXITCODE

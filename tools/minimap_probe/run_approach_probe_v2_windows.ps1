param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$LieRoi = "",
  [string]$Tesseract = "",
  [double]$AimPulseMs = 45,
  [double]$AimSettleMs = 60,
  [double]$AimReturnTolerancePx = 1.5,
  [double]$AimMaxCorrectionMs = 20,
  [int]$AimMaxCorrections = 2,
  [string]$ProfilesJson = "",
  [ValidateSet("approach", "strategic")]
  [string]$Mode = "approach",
  [double]$ExternalCarryAdjustmentYds = 0.0,
  [double]$ExternalLateralAdjustmentYds = 0.0,
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
  (Join-Path $Here "probe_approach_v2.py"),
  "--monitor", "$Monitor",
  "--aim-pulse-ms", "$AimPulseMs",
  "--aim-settle-ms", "$AimSettleMs",
  "--aim-return-tolerance-px", "$AimReturnTolerancePx",
  "--aim-max-correction-ms", "$AimMaxCorrectionMs",
  "--aim-max-corrections", "$AimMaxCorrections",
  "--mode", $Mode,
  "--external-carry-adjustment-yds", "$ExternalCarryAdjustmentYds",
  "--external-lateral-adjustment-yds", "$ExternalLateralAdjustmentYds"
)

if ($Roi) { $argsList += @("--roi", $Roi) }
if ($LieRoi) { $argsList += @("--lie-roi", $LieRoi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($ProfilesJson) { $argsList += @("--profiles-json", $ProfilesJson) }
if ($NoAimSummon) { $argsList += "--no-aim-summon" }
if ($DeepDebug) { $argsList += "--deep-debug" }

Write-Host "Running GSPro POST-TEE ShotState probe v2 once."
Write-Host "Upper-right course/hole identity selects the cached tee HoleModel."
Write-Host "Visible minimap PIN is optional; canonical registration projects the cached pin when cropped."
Write-Host "No W zoom. No Y heatmap. Recommendation aim is read-only and never applied."
Write-Host "PIN / lie / round identity OCR overlap AIM acquisition for speed."

& $Python @argsList
exit $LASTEXITCODE

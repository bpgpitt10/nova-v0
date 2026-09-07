param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$LieRoi = "",
  [string]$Tesseract = "",
  [string]$ProfilesJson = "",
  [ValidateSet("approach", "strategic")][string]$Mode = "approach",
  [double]$ExternalCarryAdjustmentYds = 0,
  [double]$ExternalLateralAdjustmentYds = 0,
  [double]$AimPulseMs = 45,
  [double]$AimSettleMs = 60,
  [double]$AimReturnTolerancePx = 1.5,
  [double]$AimMaxCorrectionMs = 20,
  [int]$AimMaxCorrections = 2,
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
  (Join-Path $Here "probe_approach_v3.py"),
  "--monitor", "$Monitor",
  "--mode", "$Mode",
  "--external-carry-adjustment-yds", "$ExternalCarryAdjustmentYds",
  "--external-lateral-adjustment-yds", "$ExternalLateralAdjustmentYds",
  "--aim-pulse-ms", "$AimPulseMs",
  "--aim-settle-ms", "$AimSettleMs",
  "--aim-return-tolerance-px", "$AimReturnTolerancePx",
  "--aim-max-correction-ms", "$AimMaxCorrectionMs",
  "--aim-max-corrections", "$AimMaxCorrections"
)

if ($Roi) { $argsList += @("--roi", $Roi) }
if ($LieRoi) { $argsList += @("--lie-roi", $LieRoi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($ProfilesJson) { $argsList += @("--profiles-json", $ProfilesJson) }
if ($NoAimSummon) { $argsList += "--no-aim-summon" }
if ($DeepDebug) { $argsList += "--deep-debug" }

Write-Host "Running GSPro POST-TEE ShotState probe v3 once."
Write-Host "Course/hole header selects the exact cached tee HoleModel."
Write-Host "Visible minimap pin is OPTIONAL; canonical registration projects the cached pin/green when cropped."
Write-Host "No W zoom. No Y heatmap. Recommendation is read-only."
Write-Host "PIN / lie / hole-identity OCR overlap AIM acquisition."

& $Python @argsList
exit $LASTEXITCODE

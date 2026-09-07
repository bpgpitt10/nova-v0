param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$LieRoi = "",
  [string]$Tesseract = "",
  [string]$ProfilesJson = "",
  [ValidateSet("auto", "approach", "strategic")][string]$Mode = "auto",
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
  (Join-Path $Here "probe_approach_v4.py"),
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

Write-Host "Running GSPro POST-TEE ShotState probe v4 once."
Write-Host "Identity selects the exact tee HoleModel; visible minimap pin is optional."
Write-Host "Shot mode defaults to AUTO: GSPro surface + canonical AIM/green geometry + AIM/PIN fallback."
if ($ProfilesJson) {
  Write-Host "Player model: explicit -ProfilesJson diagnostic override."
} else {
  Write-Host "Player model: auto-load looper-live-caddie-profiles.json published by authenticated Looper into the GSPro folder."
}
Write-Host "Approach refinement may W zoom OUT only, bounded by assumptions; it never zooms back in."
Write-Host "Y heatmap uses field-proven fixed toggle/restore timing and confidence-gated canonical merge."
Write-Host "Green/no-full-shot states skip the full-shot recommendation."
Write-Host "Recommendation is READ ONLY; no solver-driven aim movement is applied."

& $Python @argsList
exit $LASTEXITCODE

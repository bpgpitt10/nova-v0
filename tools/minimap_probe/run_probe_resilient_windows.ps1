param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$LieRoi = "",
  [string]$Tesseract = "",
  [string]$HeatmapKey = "Y",
  [double]$HeatmapSettleMs = 320,
  [double]$HeatmapPulseMs = 45,
  [double]$AimPulseMs = 45,
  [double]$AimSettleMs = 60,
  [double]$AimReturnTolerancePx = 1.5,
  [double]$AimMaxCorrectionMs = 20,
  [int]$AimMaxCorrections = 2,
  [switch]$NoAimSummon,
  [switch]$VerifyTeeLie,
  [switch]$DeepDebug,
  [switch]$NoReviewZip
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutputRoot = Join-Path $Here "output"
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

if ($HeatmapKey -notin @("Y", "y")) {
  throw "-HeatmapKey must be Y for the current GSPro heatmap capture contract."
}

$argsList = @(
  (Join-Path $Here "probe_v8_resilient.py"),
  "--monitor", "$Monitor",
  "--heatmap-key", "$HeatmapKey",
  "--heatmap-settle-ms", "$HeatmapSettleMs",
  "--heatmap-pulse-ms", "$HeatmapPulseMs",
  "--aim-pulse-ms", "$AimPulseMs",
  "--aim-settle-ms", "$AimSettleMs",
  "--aim-return-tolerance-px", "$AimReturnTolerancePx",
  "--aim-max-correction-ms", "$AimMaxCorrectionMs",
  "--aim-max-corrections", "$AimMaxCorrections"
)

if ($Roi) { $argsList += @("--roi", $Roi) }
if ($LieRoi) { $argsList += @("--lie-roi", $LieRoi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($NoAimSummon) { $argsList += "--no-aim-summon" }
if ($VerifyTeeLie) { $argsList += "--verify-tee-lie" }
if ($DeepDebug) { $argsList += "--deep-debug" }

Write-Host "Running GSPro tee-capture orchestrator v8.1 resilient once."
Write-Host "BASE MODEL survives optional green/red-penalty semantic extractor failures."
Write-Host "TEE RULE: no W zoom. Y toggle/restore only. No auto aim or extra calibration pulses."
Write-Host "Raw before/toggled/restored minimaps are retained for replay."
Write-Host "Bunker + water extractors run in TRAINING SHADOW mode after every saved tee capture."
Write-Host "Shadow hazard failures/detections never block the watcher or gain strategy authority."

$RunStart = Get-Date
& $Python @argsList
$TeeExit = $LASTEXITCODE

# Fire-and-forget semantic training pass. It consumes only the saved tee imagery,
# writes masks/JSON/overlays, and attaches non-authoritative shadow data to the
# HoleModel. It never changes the tee probe exit code or blocks the watcher.
try {
  $Capture = Get-ChildItem -Path $OutputRoot -Directory -Filter "tee_capture_*" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $RunStart.AddSeconds(-2) } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($Capture) {
    $ShadowScript = Join-Path $Here "hazard_shadow_capture.py"
    if (Test-Path $ShadowScript) {
      $ShadowArgs = @($ShadowScript, "--capture-dir", $Capture.FullName)
      Start-Process -FilePath $Python -ArgumentList $ShadowArgs -WorkingDirectory $Here -WindowStyle Hidden | Out-Null
      Write-Host "Hazard shadow queued:   $($Capture.Name) (async / non-blocking)"
    }
  }
} catch {
  Write-Warning "Could not queue hazard shadow review (non-blocking): $($_.Exception.Message)"
}

exit $TeeExit

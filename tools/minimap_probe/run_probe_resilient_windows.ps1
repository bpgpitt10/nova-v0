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
  [ValidateSet("Luna", "Gemini")]
  [string]$HazardProvider = "Luna",
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
Write-Host "Step 8+9 hazard field shadow is queued after every saved tee capture."
Write-Host "Static GKD/Unity archaeology is reused from the course/version/hash cache when available."
if ($HazardProvider -eq "Luna") {
  Write-Host "Semantic provider: OpenAI Luna enrichment after validated Step 8/9 base collection."
  if (-not $env:OPENAI_API_KEY) {
    Write-Warning "OPENAI_API_KEY is not set; Luna enrichment will fail soft and base Step 8/9 evidence will remain. Run the Luna preflight before counting this as Step 11 validation."
  }
} else {
  Write-Host "Semantic provider: legacy Gemini/SAM field shadow."
}
Write-Host "All semantic hazard layers remain TRAINING SHADOW only."
Write-Host "Shadow hazard failures/detections never block the watcher or gain strategy authority."

$RunStart = Get-Date
& $Python @argsList
$TeeExit = $LASTEXITCODE

# Fire-and-forget Step 8+9 pass. The worker waits briefly for watcher capture_context,
# consumes only saved tee artifacts, and is independent from live GSPro actuation.
# Luna is the default Step 11 field provider. It reuses the validated base collector
# with Gemini/SAM disabled, then enriches the saved capture with OpenAI semantics.
# Either provider remains fail-soft and never changes the tee probe result.
try {
  $Capture = Get-ChildItem -Path $OutputRoot -Directory -Filter "tee_capture_*" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $RunStart.AddSeconds(-2) } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($Capture) {
    $ShadowScriptName = if ($HazardProvider -eq "Luna") {
      "hazard_field_shadow_luna_cached.py"
    } else {
      "hazard_field_shadow_cached.py"
    }
    $ShadowScript = Join-Path $Here $ShadowScriptName
    if (Test-Path $ShadowScript) {
      $ShadowArgs = @($ShadowScript, "--capture-dir", $Capture.FullName)
      Start-Process -FilePath $Python -ArgumentList $ShadowArgs -WorkingDirectory $Here -WindowStyle Hidden | Out-Null
      Write-Host "Hazard field shadow queued: $($Capture.Name) | provider=$HazardProvider (async / non-blocking)"
    } else {
      Write-Warning "Hazard field shadow script missing: $ShadowScriptName"
    }
  }
} catch {
  Write-Warning "Could not queue Step 8+9 hazard field shadow (non-blocking): $($_.Exception.Message)"
}

exit $TeeExit

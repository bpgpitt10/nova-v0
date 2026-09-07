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
$RepoRoot = (Resolve-Path (Join-Path $Here "..\..")).Path
$OutputRoot = Join-Path $Here "output"
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

$argsList = @(
  (Join-Path $Here "probe_v8_fixed.py"),
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

if ($Roi) {
  $argsList += @("--roi", $Roi)
}
if ($LieRoi) {
  $argsList += @("--lie-roi", $LieRoi)
}
if ($Tesseract) {
  $argsList += @("--tesseract", $Tesseract)
}
if ($NoAimSummon) {
  $argsList += "--no-aim-summon"
}
if ($VerifyTeeLie) {
  $argsList += "--verify-tee-lie"
}
if ($DeepDebug) {
  $argsList += "--deep-debug"
}

if ($HeatmapKey -notin @("Y", "y")) {
  throw "-HeatmapKey must be Y for the current GSPro heatmap capture contract."
}

Write-Host "Running GSPro tee-capture orchestrator v8 once."
Write-Host "TEE RULE: minimap zoom is never changed; W recovery is disabled by design."
Write-Host "FAST PATH: PIN OCR + green/hazard CV overlap the GSPro UI sequence."
Write-Host "Review PNG encoding is deferred until after STATE READY."
if ($VerifyTeeLie) {
  Write-Host "Directional tee lie OCR verification enabled (diagnostic / slower)."
} else {
  Write-Host "Tee lie uses GSPro invariant 0.0 / 0.0; OCR skipped for speed."
}
Write-Host "Heatmap sequence: Y ON -> fixed proven render settle -> capture -> Y OFF -> fixed proven restore settle."
Write-Host "Heatmap settle: $HeatmapSettleMs ms (field-proven); AIM settle remains optimized at $AimSettleMs ms."
Write-Host "One canonical HEATMAP-ON minimap is written to the HoleModel."
Write-Host "Red penalty CV restores only Y-changed green pixels transiently to avoid heatmap contamination."
if ($NoAimSummon) {
  Write-Host "Automatic AIM-card summon disabled."
} else {
  Write-Host "AIM acquisition uses controlled LEFT/RIGHT ARROW return verification."
}
if ($DeepDebug) {
  Write-Host "Deep AIM debug frames enabled (diagnostic; slower critical path)."
}
Write-Host "Performance timing is enabled; STATE READY excludes review PNG/ZIP persistence."
Write-Host "Course/hole identity OCR runs after STATE READY and tags the cached HoleModel."
if (-not $NoReviewZip) {
  Write-Host "A review ZIP will be created automatically after the run."
}

$RunStart = Get-Date
$ProbeStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
& $Python @argsList
$ProbeExitCode = $LASTEXITCODE
$ProbeStopwatch.Stop()
$ProbeWallMs = [math]::Round($ProbeStopwatch.Elapsed.TotalMilliseconds, 1)
Write-Host ""
Write-Host ("Python process wall:     {0:N1} ms" -f $ProbeWallMs)

# Identity is product state, but intentionally post-ready so the proven tee capture
# critical path stays untouched. Failure to OCR identity does not invalidate the tee
# model; later cache selection will surface the lower-confidence fallback explicitly.
if ($ProbeExitCode -eq 0) {
  try {
    $IdentityArgs = @(
      (Join-Path $Here "attach_round_identity.py"),
      "--output-root", $OutputRoot
    )
    if ($Tesseract) {
      $IdentityArgs += @("--tesseract", $Tesseract)
    }
    if ($DeepDebug) {
      $IdentityArgs += "--debug"
    }
    $IdentityStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    & $Python @IdentityArgs
    $IdentityExitCode = $LASTEXITCODE
    $IdentityStopwatch.Stop()
    $IdentityMs = [math]::Round($IdentityStopwatch.Elapsed.TotalMilliseconds, 1)
    Write-Host ("Identity tagging:        {0:N1} ms (post-ready)" -f $IdentityMs)
    if ($IdentityExitCode -ne 0) {
      Write-Warning "Course/hole identity could not be attached; tee capture remains valid but cache selection will fall back conservatively."
    }
  } catch {
    Write-Warning "Could not attach course/hole identity: $($_.Exception.Message)"
  }
}

# ZIP creation is development/debug convenience only. It is intentionally outside
# the capture/recommendation critical path and can be disabled with -NoReviewZip.
if (-not $NoReviewZip) {
  try {
    if (Test-Path $OutputRoot) {
      $Capture = Get-ChildItem -Path $OutputRoot -Directory -Filter "tee_capture_*" |
        Where-Object { $_.LastWriteTime -ge $RunStart.AddSeconds(-3) } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

      if (-not $Capture) {
        $Capture = Get-ChildItem -Path $OutputRoot -Directory -Filter "tee_capture_*" |
          Sort-Object LastWriteTime -Descending |
          Select-Object -First 1
      }

      if ($Capture) {
        $Branch = (& git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1)
        $Commit = (& git -C $RepoRoot rev-parse HEAD 2>$null | Select-Object -First 1)
        $Manifest = @(
          "Looper GSPro tee-capture review bundle",
          "capture=$($Capture.Name)",
          "branch=$Branch",
          "commit=$Commit",
          "probe_exit_code=$ProbeExitCode",
          "probe_process_wall_ms=$ProbeWallMs",
          "packaged_local=$((Get-Date).ToString('s'))"
        )
        $Manifest | Set-Content -Path (Join-Path $Capture.FullName "review_manifest.txt") -Encoding UTF8

        $ReviewFiles = Get-ChildItem -Path $Capture.FullName -File |
          Where-Object { $_.Extension -ne ".zip" }

        if ($ReviewFiles.Count -gt 0) {
          $ArchiveZip = Join-Path $OutputRoot ($Capture.Name + "_review.zip")
          $LatestZip = Join-Path $OutputRoot "latest_tee_review.zip"
          $ZipStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
          Compress-Archive -Path $ReviewFiles.FullName -DestinationPath $ArchiveZip -Force
          Copy-Item -Path $ArchiveZip -Destination $LatestZip -Force
          $ZipStopwatch.Stop()
          $ZipMs = [math]::Round($ZipStopwatch.Elapsed.TotalMilliseconds, 1)
          Write-Host ""
          Write-Host "Review ZIP:           $ArchiveZip"
          Write-Host "Latest review ZIP:    $LatestZip"
          Write-Host ("ZIP packaging:        {0:N1} ms (debug only; not live critical path)" -f $ZipMs)
          Write-Host "Upload latest_tee_review.zip when we need visual review."
        }
      }
    }
  } catch {
    Write-Warning "Could not create review ZIP: $($_.Exception.Message)"
  }
}

exit $ProbeExitCode

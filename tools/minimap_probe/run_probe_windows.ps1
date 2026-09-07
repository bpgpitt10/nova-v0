param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$LieRoi = "",
  [string]$Tesseract = "",
  [string]$HeatmapKey = "Y",
  [double]$HeatmapSettleMs = 320,
  [double]$HeatmapPulseMs = 45,
  [double]$AimPulseMs = 45,
  [double]$AimSettleMs = 180,
  [double]$AimReturnTolerancePx = 1.5,
  [double]$AimMaxCorrectionMs = 20,
  [int]$AimMaxCorrections = 2,
  [switch]$NoAimSummon
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

if ($HeatmapKey -notin @("Y", "y")) {
  throw "-HeatmapKey must be Y for the current GSPro heatmap capture contract."
}

Write-Host "Running GSPro tee-capture orchestrator v8 once."
Write-Host "TEE RULE: minimap zoom is never changed; W recovery is disabled by design."
Write-Host "Screen PIN distance/elevation + minimap directional lie enabled."
Write-Host "Heatmap sequence: initial capture -> Y toggle -> registered capture -> Y restore."
Write-Host "One canonical HEATMAP-ON minimap is written to the HoleModel."
Write-Host "Red penalty CV restores only Y-changed green pixels transiently to avoid heatmap contamination."
if ($NoAimSummon) {
  Write-Host "Automatic AIM-card summon disabled."
} else {
  Write-Host "AIM acquisition runs after heatmap restoration with controlled LEFT/RIGHT ARROW return verification."
}
Write-Host "A review ZIP will be created automatically after the run."

$RunStart = Get-Date
& $Python @argsList
$ProbeExitCode = $LASTEXITCODE

# Package the just-created capture folder so one file contains everything useful
# for remote review: raw screens, minimap products, OCR crops, JSON, AIM-return
# frames, and any new debug artifacts future probe revisions add.
try {
  if (Test-Path $OutputRoot) {
    $Capture = Get-ChildItem -Path $OutputRoot -Directory -Filter "tee_capture_*" |
      Where-Object { $_.LastWriteTime -ge $RunStart.AddSeconds(-3) } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1

    if (-not $Capture) {
      # Fallback for filesystem timestamp quirks: newest tee capture is still the
      # most useful review bundle, even if its LastWriteTime missed the run window.
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
        "packaged_local=$((Get-Date).ToString('s'))"
      )
      $Manifest | Set-Content -Path (Join-Path $Capture.FullName "review_manifest.txt") -Encoding UTF8

      $ReviewFiles = Get-ChildItem -Path $Capture.FullName -File |
        Where-Object { $_.Extension -ne ".zip" }

      if ($ReviewFiles.Count -gt 0) {
        $ArchiveZip = Join-Path $OutputRoot ($Capture.Name + "_review.zip")
        $LatestZip = Join-Path $OutputRoot "latest_tee_review.zip"
        Compress-Archive -Path $ReviewFiles.FullName -DestinationPath $ArchiveZip -Force
        Copy-Item -Path $ArchiveZip -Destination $LatestZip -Force
        Write-Host ""
        Write-Host "Review ZIP:           $ArchiveZip"
        Write-Host "Latest review ZIP:    $LatestZip"
        Write-Host "Upload latest_tee_review.zip next time instead of selecting individual files."
      }
    }
  }
} catch {
  # Packaging must never turn a successful capture into a failed capture.
  Write-Warning "Could not create review ZIP: $($_.Exception.Message)"
}

exit $ProbeExitCode

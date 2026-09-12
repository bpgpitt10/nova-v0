param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [string]$Manifest = "tools\minimap_probe\regression\step11_20260911_farmlinks.json",
  [string]$SamModel = "facebook/sam2.1-hiera-tiny"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot
$RunStart = Get-Date
$OutputPath = Join-Path $RepoRoot $OutputRoot
$ManifestPath = Join-Path $RepoRoot $Manifest

Write-Host "Looper FarmLinks TRUTH HARVEST" -ForegroundColor Green
Write-Host "Source files + saved Luna boxes + SAM2 + locked Step 11 regression + Step 10 comparison."
Write-Host "READ ONLY against GSPro/course files. NO GSPro input. NO VLM API calls. Strategy authority OFF."

if (-not (Test-Path $ManifestPath)) { throw "Regression manifest missing: $ManifestPath" }
$RegressionManifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
$ValidCases = @($RegressionManifest.tee_cases | Where-Object { $_.expect_base_geometry -eq $true })
if ($ValidCases.Count -lt 1) { throw "Regression manifest contains no valid tee cases." }
$CapturePaths = @()
foreach ($Case in $ValidCases) {
  $Path = Join-Path $OutputPath $Case.capture
  if (-not (Test-Path $Path)) { throw "Saved tee capture missing: $Path" }
  $CapturePaths += $Path
}

Write-Host ""
Write-Host "=== 1/6 Fresh FarmLinks GKD + Unity archaeology ===" -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run_farmlinks_source_geometry_windows.ps1") -OutputRoot $OutputRoot -RecentRounds 1
if ($LASTEXITCODE -ne 0) { throw "FarmLinks source-geometry archaeology failed." }

$GkdDir = Get-ChildItem -Path $OutputPath -Directory -Filter "gkd_archaeology_*" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$AssetDir = Get-ChildItem -Path $OutputPath -Directory -Filter "course_asset_archaeology_*" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $GkdDir -or -not $AssetDir) { throw "Fresh archaeology output directories could not be located." }
$GkdFeatures = Join-Path $GkdDir.FullName "features.json"
$UnityGeometry = Join-Path $AssetDir.FullName "geometry_candidates.json"
if (-not (Test-Path $GkdFeatures)) { throw "GKD features.json missing: $GkdFeatures" }
if (-not (Test-Path $UnityGeometry)) { throw "Unity geometry_candidates.json missing: $UnityGeometry" }

$VenvRoot = Join-Path $PSScriptRoot ".venv"
$Python = Join-Path $VenvRoot "Scripts\python.exe"
if (-not (Test-Path $Python)) { throw "Minimap probe Python environment missing after archaeology run." }

Write-Host ""
Write-Host "=== 2/6 Merge hazard-relevant source geometry without overwriting Luna ===" -ForegroundColor Cyan
$MergeArgs = @("tools\minimap_probe\hazard_source_geometry_merge.py")
foreach ($Capture in $CapturePaths) { $MergeArgs += @("--capture-dir", $Capture) }
$MergeArgs += @(
  "--source", $GkdFeatures,
  "--source", $UnityGeometry,
  "--course-key", "$($RegressionManifest.course_key)",
  "--course-name", "$($RegressionManifest.course_name)",
  "--round-id", "$($RegressionManifest.round_id)"
)
& $Python @MergeArgs
if ($LASTEXITCODE -ne 0) { throw "Fresh source-geometry merge failed." }

Write-Host ""
Write-Host "=== 3/6 Saved Luna boxes -> local SAM2, with ZERO API calls ===" -ForegroundColor Cyan
& $Python -c "import torch; from transformers import Sam2Model, Sam2Processor; from PIL import Image" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Installing SAM2 field-lab dependencies. First run can take a while."
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements_sam2.txt"
  if ($LASTEXITCODE -ne 0) { throw "SAM2 dependency installation failed." }
}
$SamArgs = @(
  "tools\minimap_probe\hazard_luna_sam2_replay.py",
  "--output-root", $OutputRoot,
  "--sam-model", $SamModel
)
foreach ($Capture in $CapturePaths) { $SamArgs += @("--capture-dir", $Capture) }
& $Python @SamArgs
if ($LASTEXITCODE -ne 0) { throw "Saved Luna -> SAM2 replay failed. No API retry was attempted." }

Write-Host ""
Write-Host "=== 4/6 Replay locked Step 11 field regressions ===" -ForegroundColor Cyan
$RegressionResult = Join-Path $OutputPath "step11_20260911_regression_result.json"
& $Python "tools\minimap_probe\hazard_step11_regression_suite.py" `
  --manifest $ManifestPath `
  --output-root $OutputPath `
  --json-out $RegressionResult
if ($LASTEXITCODE -ne 0) { throw "Locked Step 11 field regression failed. Stop here rather than hiding the regression." }

Write-Host ""
Write-Host "=== 5/6 Build canonical shadow HazardMaps ===" -ForegroundColor Cyan
foreach ($Capture in $CapturePaths) {
  & $Python "tools\minimap_probe\hazard_map_shadow.py" --capture-dir $Capture
  if ($LASTEXITCODE -ne 0) { throw "HazardMap shadow build failed for $Capture" }
}

Write-Host ""
Write-Host "=== 6/6 Compare all sources against tonight's physical shot truth ===" -ForegroundColor Cyan
$FirstContext = Get-Content (Join-Path $CapturePaths[0] "capture_context.json") -Raw | ConvertFrom-Json
$SessionId = $FirstContext.watcher_session_id
if (-not $SessionId) { throw "watcher_session_id missing from saved tee capture context." }
$RoundDir = Join-Path $OutputPath ("round_watch_corpus_v3\" + $SessionId + "\current_round")
$RoundFiles = @()
if (Test-Path $RoundDir) {
  $RoundFiles = @(Get-ChildItem -Path $RoundDir -File -Filter "*.dat" | Sort-Object Name | ForEach-Object { $_.FullName })
}
if ($RoundFiles.Count -eq 0) { throw "No saved currentRound truth snapshots found for watcher session $SessionId at $RoundDir" }

$CompareArgs = @(
  "tools\minimap_probe\hazard_compare_report.py",
  "--output-root", $OutputRoot
)
foreach ($Capture in $CapturePaths) { $CompareArgs += @("--bundle", (Join-Path $Capture "hazard_geometry_v0.json")) }
foreach ($RoundFile in $RoundFiles) { $CompareArgs += @("--current-round", $RoundFile) }
& $Python @CompareArgs
if ($LASTEXITCODE -ne 0) { throw "Step 10 comparison reported errors. Review its output instead of promoting anything." }

$CompareDir = Get-ChildItem -Path $OutputPath -Directory -Filter "hazard_comparison_*" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $CompareDir) { throw "Could not locate Step 10 comparison output." }

# Build one compact upload artifact containing only decision-relevant evidence.
$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$Stage = Join-Path $OutputPath ("farmlinks_truth_harvest_review_" + $Stamp)
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

Copy-Item $ManifestPath (Join-Path $Stage "step11_regression_manifest.json") -Force
if (Test-Path $RegressionResult) { Copy-Item $RegressionResult $Stage -Force }
$SamSummary = Join-Path $OutputPath "hazard_luna_sam2_saved_replay_v0.json"
if (Test-Path $SamSummary) { Copy-Item $SamSummary $Stage -Force }
Copy-Item $CompareDir.FullName (Join-Path $Stage "step10_comparison") -Recurse -Force

$GkdStage = Join-Path $Stage "gkd"
$AssetStage = Join-Path $Stage "course_assets"
New-Item -ItemType Directory -Path $GkdStage -Force | Out-Null
New-Item -ItemType Directory -Path $AssetStage -Force | Out-Null
foreach ($Name in @("summary.json","features.json","variant_comparison.json","round_course_context.json","manifest.json")) {
  $Source = Join-Path $GkdDir.FullName $Name
  if (Test-Path $Source) { Copy-Item $Source $GkdStage -Force }
}
foreach ($Name in @("summary.json","semantic_candidates.json","geometry_candidates.json","reference_graph.json","mesh_exports.json","round_course_context.json","manifest.json")) {
  $Source = Join-Path $AssetDir.FullName $Name
  if (Test-Path $Source) { Copy-Item $Source $AssetStage -Force }
}

$CaptureStage = Join-Path $Stage "tee_captures"
New-Item -ItemType Directory -Path $CaptureStage -Force | Out-Null
foreach ($Capture in $CapturePaths) {
  $Dest = Join-Path $CaptureStage ([IO.Path]::GetFileName($Capture))
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null
  foreach ($Name in @(
    "capture_context.json",
    "hole_model.json",
    "hazard_field_shadow_v0.json",
    "hazard_geometry_v0.json",
    "hazard_map_shadow_v0.json",
    "tee_hazard_safe_minimap.png"
  )) {
    $Source = Join-Path $Capture $Name
    if (Test-Path $Source) { Copy-Item $Source $Dest -Force }
  }
  Get-ChildItem -Path $Capture -File -Filter "hazard_vlm_response_openai_*" -ErrorAction SilentlyContinue | Copy-Item -Destination $Dest -Force
  Get-ChildItem -Path $Capture -File -Filter "hazard_vlm_meta_openai_*" -ErrorAction SilentlyContinue | Copy-Item -Destination $Dest -Force
  Get-ChildItem -Path $Capture -File -Filter "hazard_sam2_*" -ErrorAction SilentlyContinue | Copy-Item -Destination $Dest -Force
  Get-ChildItem -Path $Capture -Directory -Filter "hazard_sam2_*" -ErrorAction SilentlyContinue | Copy-Item -Destination $Dest -Recurse -Force
}

$Readme = @"
Looper FarmLinks truth harvest
Created: $(Get-Date -Format o)
Course: $($RegressionManifest.course_name)
Course key: $($RegressionManifest.course_key)
Watcher session: $SessionId

Included:
- fresh read-only GKD and Unity hazard-relevant archaeology
- saved Luna semantic boxes (no new VLM API calls)
- local SAM2 exact-mask replay
- locked Step 11 field regression result
- canonical shadow HazardMaps
- Step 10 cross-source + physical-shot truth comparison

Strategy authority remains false. Promotion decision remains none.
"@
Set-Content -Path (Join-Path $Stage "README.txt") -Value $Readme -Encoding UTF8

$Desktop = [Environment]::GetFolderPath("Desktop")
$Zip = Join-Path $Desktop ("looper-farmlinks-truth-harvest-" + $Stamp + ".zip")
Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $Zip -Force
$ZipItem = Get-Item $Zip

Write-Host ""
Write-Host "FARMLINKS TRUTH HARVEST COMPLETE" -ForegroundColor Green
Write-Host "Review ZIP: $Zip"
Write-Host ("ZIP size:   " + [math]::Round($ZipItem.Length / 1MB, 1) + " MB")
Write-Host "No GSPro input was sent. No VLM API call was made. No strategy source was promoted."

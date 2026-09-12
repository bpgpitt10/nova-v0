param(
  [string]$CourseFolder,
  [string]$OutputRoot = "tools\minimap_probe\output",
  [int]$RecentRounds = 1
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$RunStart = Get-Date
$GkdRunner = Join-Path $PSScriptRoot "run_gkd_archaeology_windows.ps1"
$AssetRunner = Join-Path $PSScriptRoot "run_course_asset_archaeology_windows.ps1"

function Invoke-ChildPowerShell([string]$ScriptPath, [string[]]$ArgsList) {
  Write-Host ""
  Write-Host ("=== " + [IO.Path]::GetFileName($ScriptPath) + " ===") -ForegroundColor Cyan
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @ArgsList
  if ($LASTEXITCODE -ne 0) {
    throw "Child archaeology runner failed with exit code $LASTEXITCODE: $ScriptPath"
  }
}

$Common = @("-OutputRoot", $OutputRoot, "-RecentRounds", "$RecentRounds")
if ($CourseFolder) { $Common += @("-CourseFolder", $CourseFolder) }

Write-Host "Looper FarmLinks source-geometry archaeology" -ForegroundColor Green
Write-Host "READ ONLY: no GSPro actuation, no screen capture, no strategy changes."
Write-Host "Using only the latest recent Round by default so course resolution targets tonight's FarmLinks round."

Invoke-ChildPowerShell $GkdRunner $Common

$AssetArgs = @($Common + @("-NoZip"))
Invoke-ChildPowerShell $AssetRunner $AssetArgs

$OutputPath = Join-Path $RepoRoot $OutputRoot
$GkdDir = Get-ChildItem -Path $OutputPath -Directory -Filter "gkd_archaeology_*" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -ge $RunStart.AddSeconds(-5) } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$AssetDir = Get-ChildItem -Path $OutputPath -Directory -Filter "course_asset_archaeology_*" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -ge $RunStart.AddSeconds(-5) } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $GkdDir) { throw "Could not locate the new GKD archaeology output directory." }
if (-not $AssetDir) { throw "Could not locate the new course-asset archaeology output directory." }

$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$Stage = Join-Path $OutputPath ("farmlinks_source_geometry_review_" + $Stamp)
$GkdStage = Join-Path $Stage "gkd"
$AssetStage = Join-Path $Stage "course_assets"
New-Item -ItemType Directory -Path $GkdStage -Force | Out-Null
New-Item -ItemType Directory -Path $AssetStage -Force | Out-Null

function Copy-ReviewFile([string]$SourceDir, [string]$RelativePath, [string]$DestDir, [int64]$MaxBytes = 104857600) {
  $Source = Join-Path $SourceDir $RelativePath
  if (-not (Test-Path $Source)) { return }
  $Item = Get-Item $Source
  if ($Item.PSIsContainer) {
    Copy-Item $Source -Destination $DestDir -Recurse -Force
  } elseif ($Item.Length -le $MaxBytes) {
    Copy-Item $Source -Destination (Join-Path $DestDir $Item.Name) -Force
  } else {
    Write-Warning "Skipped oversized review file: $RelativePath ($([math]::Round($Item.Length / 1MB, 1)) MB)"
  }
}

foreach ($Name in @(
  "summary.json",
  "features.json",
  "schema_inventory.json",
  "variant_comparison.json",
  "round_course_context.json",
  "manifest.json",
  "reports"
)) {
  Copy-ReviewFile $GkdDir.FullName $Name $GkdStage
}

foreach ($Name in @(
  "summary.json",
  "asset_inventory.json",
  "semantic_candidates.json",
  "geometry_candidates.json",
  "reference_graph.json",
  "mesh_exports.json",
  "round_course_context.json",
  "manifest.json"
)) {
  Copy-ReviewFile $AssetDir.FullName $Name $AssetStage
}

# unity_objects.json can be very useful but can also be huge. Include it only when upload-safe.
Copy-ReviewFile $AssetDir.FullName "unity_objects.json" $AssetStage 157286400

$Readme = @"
Looper FarmLinks source-geometry archaeology review
Created: $(Get-Date -Format o)

GKD source directory:
$($GkdDir.FullName)

Unity/course-asset source directory:
$($AssetDir.FullName)

This review ZIP intentionally excludes candidate_meshes/*.obj to stay upload-friendly.
If semantic/geometry candidates look promising, upload specific OBJ candidates in a second pass.
All archaeology is read-only and strategy_authority remains false.
"@
Set-Content -Path (Join-Path $Stage "README.txt") -Value $Readme -Encoding UTF8

$ContextText = ""
foreach ($Ctx in @(
  (Join-Path $GkdDir.FullName "round_course_context.json"),
  (Join-Path $AssetDir.FullName "round_course_context.json")
)) {
  if (Test-Path $Ctx) { $ContextText += (Get-Content $Ctx -Raw) + "`n" }
}
if ($ContextText -notmatch "(?i)farm\s*links|farmlinks|farmlinks_al_2_7_gsp") {
  Write-Warning "The generated round context did not clearly contain FarmLinks. Do not assume the right course was selected; upload the ZIP and console output for review."
} else {
  Write-Host "FarmLinks identity found in archaeology round context." -ForegroundColor Green
}

$Desktop = [Environment]::GetFolderPath("Desktop")
$Zip = Join-Path $Desktop ("looper-farmlinks-source-geometry-" + $Stamp + ".zip")
Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $Zip -Force

$ZipItem = Get-Item $Zip
Write-Host ""
Write-Host "SOURCE GEOMETRY ARCHAEOLOGY COMPLETE" -ForegroundColor Green
Write-Host "GKD output:    $($GkdDir.FullName)"
Write-Host "Asset output:  $($AssetDir.FullName)"
Write-Host "Review ZIP:    $Zip"
Write-Host ("ZIP size:      " + [math]::Round($ZipItem.Length / 1MB, 1) + " MB")
Write-Host "Upload the review ZIP here. If we find authoritative mesh candidates, I will ask for only those specific OBJ files next."

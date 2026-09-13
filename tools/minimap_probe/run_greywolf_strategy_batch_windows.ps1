param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [int]$Latest = 18,
  [string]$Stations = "160,180,200,220,240,260,280"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

Write-Host "Looper Greywolf strategy batch"
Write-Host "ONE RUN: screenshot geometry -> fairway corridor -> self-contained review ZIP"
Write-Host "No GSPro input. No new shots. Strategy authority OFF."
Write-Host "You can leave this running unattended."
Write-Host ""

$GeometryRunner = Join-Path $PSScriptRoot "run_screenshot_strategy_geometry_v2_windows.ps1"
$CorridorRunner = Join-Path $PSScriptRoot "run_fairway_corridor_v1_windows.ps1"

if (-not (Test-Path $GeometryRunner)) { throw "Missing $GeometryRunner" }
if (-not (Test-Path $CorridorRunner)) { throw "Missing $CorridorRunner" }

Write-Host "=== 1/2 Build latest screenshot-first strategy geometry ==="
& powershell -ExecutionPolicy Bypass -File $GeometryRunner -OutputRoot $OutputRoot -Latest $Latest
if ($LASTEXITCODE -ne 0) { throw "Screenshot strategy geometry batch failed." }

Write-Host ""
Write-Host "=== 2/2 Build landing-station fairway corridor and review bundle ==="
& powershell -ExecutionPolicy Bypass -File $CorridorRunner -OutputRoot $OutputRoot -Latest $Latest -Stations $Stations
if ($LASTEXITCODE -ne 0) { throw "Fairway Corridor batch failed." }

$OutputPath = (Resolve-Path $OutputRoot).Path
$ReviewZip = Get-ChildItem -Path $OutputPath -Filter "fairway_corridor_review_*.zip" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

Write-Host ""
Write-Host "============================================="
Write-Host "BATCH COMPLETE"
if ($null -ne $ReviewZip) {
  Write-Host "UPLOAD THIS ONE FILE:"
  Write-Host $ReviewZip.FullName
} else {
  Write-Host "Review ZIP was not found even though the corridor runner returned success."
  exit 1
}
Write-Host "============================================="
Write-Host "No other files are needed from this PC for the current strategy review."

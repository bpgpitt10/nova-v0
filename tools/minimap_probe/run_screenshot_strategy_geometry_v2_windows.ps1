param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [int]$Latest = 18,
  [switch]$ForceRed
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$Python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { throw "minimap-probe .venv missing; run the bunker recall runner first." }

Write-Host "Running screenshot strategy geometry v2 tests..."
& $Python "tools\minimap_probe\test_white_boundary_pixel_geometry_v1.py"
if ($LASTEXITCODE -ne 0) { throw "White boundary geometry tests failed." }
& $Python "tools\minimap_probe\test_screenshot_strategy_geometry_v2.py"
if ($LASTEXITCODE -ne 0) { throw "Screenshot strategy geometry v2 tests failed." }
& $Python "tools\minimap_probe\test_strategy_risk_v0.py"
if ($LASTEXITCODE -ne 0) { throw "Strategy risk v0 tests failed." }
& $Python "tools\minimap_probe\test_strategy_risk_overlay_v0.py"
if ($LASTEXITCODE -ne 0) { throw "Strategy risk overlay v0 tests failed." }
& $Python "tools\minimap_probe\test_strategy_risk_overlay_v1.py"
if ($LASTEXITCODE -ne 0) { throw "Strategy risk overlay v1 tests failed." }
& $Python "tools\minimap_probe\test_strategy_fairway_section_v0.py"
if ($LASTEXITCODE -ne 0) { throw "Strategy fairway section v0 tests failed." }

$ArgsList = @(
  "tools\minimap_probe\screenshot_strategy_geometry_v2.py",
  "--capture-root", $OutputRoot,
  "--latest", "$Latest"
)
if ($ForceRed) { $ArgsList += "--force-red" }

Write-Host ""
Write-Host "Building screenshot-first strategy geometry v2..."
Write-Host "Original GSPro minimap = visual truth | bunker recall = bunker geometry | red CV = penalty geometry | white CV = OB geometry"
Write-Host "No API calls. No GSPro input. Strategy authority OFF."
& $Python @ArgsList
exit $LASTEXITCODE

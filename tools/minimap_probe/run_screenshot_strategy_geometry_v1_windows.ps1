param(
  [string[]]$CaptureRoot = @(),
  [string[]]$CaptureDir = @(),
  [int]$Latest = 18,
  [switch]$ForceRed
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$Python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
  if (Get-Command py -ErrorAction SilentlyContinue) { $Python = "py" }
  elseif (Get-Command python -ErrorAction SilentlyContinue) { $Python = "python" }
  else { throw "Python was not found." }
}

Write-Host "Checking screenshot strategy geometry syntax/tests..."
Push-Location $PSScriptRoot
try {
  & $Python -m unittest test_red_penalty_pixel_geometry_v1 test_screenshot_strategy_geometry_v1 -v
  if ($LASTEXITCODE -ne 0) { throw "Screenshot strategy geometry tests failed." }
} finally {
  Pop-Location
}

$ArgsList = @(
  "tools\minimap_probe\screenshot_strategy_geometry_v1.py",
  "--latest", "$Latest"
)
foreach ($Path in $CaptureRoot) { if ($Path) { $ArgsList += @("--capture-root", $Path) } }
foreach ($Path in $CaptureDir) { if ($Path) { $ArgsList += @("--capture-dir", $Path) } }
if ($ForceRed) { $ArgsList += "--force-red" }

Write-Host ""
Write-Host "Looper Screenshot Strategy Geometry v1"
Write-Host "Original GSPro tee minimap = visual truth. No synthetic redraw."
Write-Host "Exact red boundary pixels + canonical in-bounds hazard polygons only."
Write-Host "Semantic boxes are evidence only. No API calls. Strategy authority OFF."
Write-Host ""
& $Python @ArgsList
exit $LASTEXITCODE

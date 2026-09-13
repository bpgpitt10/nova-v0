param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [int]$Latest = 18,
  [string]$Stations = "160,180,200,220,240,260,280"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$Python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
  throw "minimap-probe .venv missing; run the bunker recall runner first."
}

Write-Host "Looper Fairway Corridor v1 preflight"
Write-Host "Original GSPro minimap = visual truth. Whole-hole fairway polygon is NOT strategy input."
Write-Host "Luna station edges -> local geometry QA -> small deterministic edge snap."
Write-Host "No GSPro input. No recommendation. Strategy authority OFF."
Write-Host ""

& $Python -m pip check
if ($LASTEXITCODE -ne 0) { throw "pip check failed." }

Write-Host "Running local Fairway Corridor v1 tests before API calls..."
& $Python "tools\minimap_probe\test_fairway_corridor_v1.py"
if ($LASTEXITCODE -ne 0) { throw "Fairway Corridor v1 tests failed." }

$HasOpenAI = -not [string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)
$HasGemini = -not [string]::IsNullOrWhiteSpace($env:GEMINI_API_KEY)
if (-not $HasOpenAI -and -not $HasGemini) {
  throw "Neither OPENAI_API_KEY nor GEMINI_API_KEY is available in this PowerShell process."
}

$Provider = if ($HasOpenAI) { "luna" } else { "gemini" }
$Fallback = if ($HasOpenAI -and $HasGemini) { "gemini" } else { "" }
Write-Host "Provider: $Provider | fallback: $(if ($Fallback) { $Fallback } else { 'none' })"
Write-Host ""
Write-Host "Running landing-station corridor replay on the latest saved tee captures..."

$ArgsList = @(
  "tools\minimap_probe\fairway_corridor_v1.py",
  "--capture-root", $OutputRoot,
  "--latest", "$Latest",
  "--stations", $Stations,
  "--provider", $Provider,
  "--force"
)
if ($Fallback) {
  $ArgsList += @("--fallback-provider", $Fallback)
} else {
  $ArgsList += @("--fallback-provider", "")
}

& $Python @ArgsList
if ($LASTEXITCODE -ne 0) { throw "Fairway Corridor v1 replay failed." }

Write-Host ""
Write-Host "Building one visual review bundle..."
& $Python "tools\minimap_probe\fairway_corridor_review_v1.py" --capture-root $OutputRoot --latest $Latest
if ($LASTEXITCODE -ne 0) { throw "Fairway Corridor v1 review packaging failed." }

Write-Host ""
Write-Host "Strategy authority: OFF | Recommendation: NONE"

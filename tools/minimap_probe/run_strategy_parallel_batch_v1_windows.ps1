param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [int]$Latest = 18,
  [string]$Carries = "180,200,220,240,260",
  [int]$BaselineCarry = 220
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$Python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
  throw "minimap-probe .venv missing; run the existing bunker-recall setup once."
}

Write-Host "Looper parallel strategy validation v1"
Write-Host "One unattended batch: strategy geometry + course visual profile + profile-aware carry arcs + old-prompt control + cross-carry route + one ZIP."
Write-Host "No GSPro input. No recommendation. Existing GSPro physics taxonomy only. Strategy authority OFF."
Write-Host ""

& $Python -m pip check
if ($LASTEXITCODE -ne 0) { throw "pip check failed." }

Write-Host "Running local regression tests before API calls..."
$Tests = @(
  "tools\minimap_probe\test_strategy_carry_arc_v0.py",
  "tools\minimap_probe\test_course_visual_profile_v0.py",
  "tools\minimap_probe\test_strategy_carry_arc_v1.py",
  "tools\minimap_probe\test_strategy_carry_route_shadow_v0.py"
)
foreach ($Test in $Tests) {
  & $Python $Test
  if ($LASTEXITCODE -ne 0) { throw "Regression test failed: $Test" }
}

$HasOpenAI = -not [string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)
$HasGemini = -not [string]::IsNullOrWhiteSpace($env:GEMINI_API_KEY)
if (-not $HasOpenAI -and -not $HasGemini) {
  throw "Neither OPENAI_API_KEY nor GEMINI_API_KEY is available in this PowerShell process."
}
$Provider = if ($HasOpenAI) { "luna" } else { "gemini" }
$Fallback = if ($HasOpenAI -and $HasGemini) { "gemini" } else { "" }
Write-Host "Provider: $Provider | fallback: $(if ($Fallback) { $Fallback } else { 'none' })"

Write-Host ""
Write-Host "1/6 Refreshing screenshot-first strategy geometry from saved captures..."
& $Python "tools\minimap_probe\screenshot_strategy_geometry_v2.py" --capture-root $OutputRoot --latest $Latest
if ($LASTEXITCODE -ne 0) { throw "Screenshot strategy geometry v2 failed." }

Write-Host ""
Write-Host "2/6 Building one cached course visual profile from representative tee minimaps..."
if ($HasOpenAI) {
  & $Python "tools\minimap_probe\course_visual_profile_v0.py" --capture-root $OutputRoot --latest $Latest --max-images 8 --force
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Course visual profile failed; continuing with screenshot-only carry prompts."
  }
} else {
  Write-Warning "OPENAI_API_KEY unavailable; skipping Luna course visual profile and continuing with screenshot-only prompts."
}

Write-Host ""
Write-Host "3/6 Running tightened profile-aware carry arcs at $Carries yards..."
$V1Args = @(
  "tools\minimap_probe\strategy_carry_arc_v1.py",
  "--capture-root", $OutputRoot,
  "--latest", "$Latest",
  "--carries", $Carries,
  "--provider", $Provider,
  "--force"
)
if ($Fallback) { $V1Args += @("--fallback-provider", $Fallback) } else { $V1Args += @("--fallback-provider", "") }
& $Python @V1Args
if ($LASTEXITCODE -ne 0) { throw "Profile-aware Carry Arc v1 replay failed." }

Write-Host ""
Write-Host "4/6 Running the old carry-arc prompt at ${BaselineCarry}y as a control..."
$V0Args = @(
  "tools\minimap_probe\strategy_carry_arc_v0.py",
  "--capture-root", $OutputRoot,
  "--latest", "$Latest",
  "--carries", "$BaselineCarry",
  "--provider", $Provider,
  "--force"
)
if ($Fallback) { $V0Args += @("--fallback-provider", $Fallback) } else { $V0Args += @("--fallback-provider", "") }
& $Python @V0Args
if ($LASTEXITCODE -ne 0) { throw "Carry Arc v0 control replay failed." }

Write-Host ""
Write-Host "5/6 Joining independent carries into one current-hole route hypothesis..."
& $Python "tools\minimap_probe\strategy_carry_route_shadow_v0.py" --capture-root $OutputRoot --latest $Latest
if ($LASTEXITCODE -ne 0) { throw "Carry route shadow failed." }

Write-Host ""
Write-Host "6/6 Packaging course profile, v1 carries, v0 control, route, hazards, transforms and screenshots into one ZIP..."
& $Python "tools\minimap_probe\strategy_parallel_review_v1.py" --capture-root $OutputRoot --latest $Latest --baseline-carry $BaselineCarry
if ($LASTEXITCODE -ne 0) { throw "Parallel review packaging failed." }

Write-Host ""
Write-Host "Finished. Upload ONLY the strategy_parallel_review_*.zip printed above."
Write-Host "Strategy authority: OFF | Recommendation: NONE"

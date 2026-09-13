param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [int]$Latest = 18,
  [string]$Carries = "200,230,260"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$Python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
  throw "minimap-probe .venv missing; run the existing bunker-recall setup once."
}

Write-Host "Looper Strategy Carry Arc v0 preflight"
Write-Host "One carry-radius arc at a time. Dogleg-safe. Par-3 and beyond-green carries skipped."
Write-Host "No GSPro input. No recommendation. Strategy authority OFF."
Write-Host ""

& $Python -m pip check
if ($LASTEXITCODE -ne 0) { throw "pip check failed." }

Write-Host "Running local Carry Arc v0 regression tests before API calls..."
& $Python "tools\minimap_probe\test_strategy_carry_arc_v0.py"
if ($LASTEXITCODE -ne 0) { throw "Carry Arc v0 tests failed." }

$HasOpenAI = -not [string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)
$HasGemini = -not [string]::IsNullOrWhiteSpace($env:GEMINI_API_KEY)
if (-not $HasOpenAI -and -not $HasGemini) {
  throw "Neither OPENAI_API_KEY nor GEMINI_API_KEY is available in this PowerShell process."
}

$Provider = if ($HasOpenAI) { "luna" } else { "gemini" }
$Fallback = if ($HasOpenAI -and $HasGemini) { "gemini" } else { "" }
Write-Host "Provider: $Provider | fallback: $(if ($Fallback) { $Fallback } else { 'none' })"
Write-Host ""
Write-Host "Running carry-arc replay over saved Greywolf tee captures..."

$ArgsList = @(
  "tools\minimap_probe\strategy_carry_arc_v0.py",
  "--capture-root", $OutputRoot,
  "--latest", "$Latest",
  "--carries", $Carries,
  "--provider", $Provider,
  "--force"
)
if ($Fallback) {
  $ArgsList += @("--fallback-provider", $Fallback)
} else {
  $ArgsList += @("--fallback-provider", "")
}

& $Python @ArgsList
if ($LASTEXITCODE -ne 0) { throw "Carry Arc v0 replay failed." }

Write-Host ""
Write-Host "Building one self-contained review bundle..."
& $Python "tools\minimap_probe\strategy_carry_arc_review_v0.py" --capture-root $OutputRoot --latest $Latest --preferred-carry 230
if ($LASTEXITCODE -ne 0) { throw "Carry Arc review packaging failed." }

Write-Host ""
Write-Host "Strategy authority: OFF | Recommendation: NONE"

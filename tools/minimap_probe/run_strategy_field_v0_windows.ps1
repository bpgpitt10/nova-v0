param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [Parameter(Mandatory=$true)][string]$PlayerProfileJson,
  [int]$Latest = 18,
  [string]$Provider = "luna",
  [string]$FallbackProvider = "gemini",
  [string]$GameplayContextJson = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot
$Python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { throw "minimap-probe .venv missing" }
if (-not (Test-Path $PlayerProfileJson)) { throw "Player profile not found: $PlayerProfileJson" }

$Profile = Get-Content -Raw $PlayerProfileJson | ConvertFrom-Json
$Mean = [double]$Profile.carry_mean_yds
$Sigma = [double]$Profile.carry_sigma_yds
if ($Mean -le 0 -or $Sigma -le 0) { throw "Player profile needs positive carry_mean_yds and carry_sigma_yds" }
$Carries = @(-2,-1,0,1,2) | ForEach-Object { [math]::Round([math]::Max(1, $Mean + $_ * $Sigma)) } | Sort-Object -Unique
$CarryCsv = ($Carries -join ',')

Write-Host "Looper Strategy Field v0 preflight"
Write-Host "Player distribution carries: $CarryCsv"
Write-Host "Carry arcs are query slices, not recommendations. Strategy authority OFF."

& $Python "tools\minimap_probe\test_strategy_carry_arc_v0.py"
if ($LASTEXITCODE -ne 0) { throw "Carry Arc regression tests failed" }
& $Python "tools\minimap_probe\test_strategy_field_v0.py"
if ($LASTEXITCODE -ne 0) { throw "Strategy Field tests failed" }

$ArcArgs = @(
  "tools\minimap_probe\strategy_carry_arc_v1.py",
  "--capture-root", $OutputRoot,
  "--latest", "$Latest",
  "--carries", $CarryCsv,
  "--provider", $Provider,
  "--fallback-provider", $FallbackProvider,
  "--force"
)
& $Python @ArcArgs
if ($LASTEXITCODE -ne 0) { throw "Carry Arc v1 replay failed" }

$Summaries = Get-ChildItem -Path $OutputRoot -Recurse -File -Filter "strategy_carry_arc_v1.json" |
  Sort-Object LastWriteTime |
  Select-Object -Last $Latest

if (-not $Summaries) { throw "No carry-arc v1 summaries found after replay" }
foreach ($Summary in $Summaries) {
  $CaptureDir = $Summary.Directory.FullName
  $ArgsList = @(
    "tools\minimap_probe\strategy_field_v0.py",
    "--capture-dir", $CaptureDir,
    "--player-profile-json", $PlayerProfileJson
  )
  if (-not [string]::IsNullOrWhiteSpace($GameplayContextJson)) {
    $ArgsList += @("--gameplay-context-json", $GameplayContextJson)
  }
  & $Python @ArgsList
  if ($LASTEXITCODE -ne 0) { throw "Strategy Field failed for $CaptureDir" }
}

Write-Host ""
Write-Host "Strategy field replay complete."
Write-Host "No club choice. No aim recommendation. No wind/lie/elevation silently applied."

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
if (-not [string]::IsNullOrWhiteSpace($GameplayContextJson) -and -not (Test-Path $GameplayContextJson)) {
  throw "Gameplay context not found: $GameplayContextJson"
}

$Profile = Get-Content -Raw $PlayerProfileJson | ConvertFrom-Json
$Mean = [double]$Profile.carry_mean_yds
$Sigma = [double]$Profile.carry_sigma_yds
if ($Mean -le 0 -or $Sigma -le 0) { throw "Player profile needs positive carry_mean_yds and carry_sigma_yds" }
$Carries = @(-2,-1,0,1,2) | ForEach-Object { [math]::Round([math]::Max(1, $Mean + $_ * $Sigma)) } | Sort-Object -Unique
$CarryCsv = ($Carries -join ',')

Write-Host "Looper Strategy Field v0 preflight"
Write-Host "Player distribution carries: $CarryCsv"
Write-Host "Carry arcs are query slices, not recommendations. Strategy authority OFF."
Write-Host "ShotState elevation is preserved as scoped PIN/AIM point context; no terrain/elevation model is implied."

& $Python "tools\minimap_probe\test_strategy_carry_arc_v0.py"
if ($LASTEXITCODE -ne 0) { throw "Carry Arc regression tests failed" }
& $Python "tools\minimap_probe\test_strategy_gameplay_context_v0.py"
if ($LASTEXITCODE -ne 0) { throw "Strategy gameplay-context tests failed" }
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
  $ContextForCapture = ""
  $ShotState = Join-Path $CaptureDir "shot_state.json"

  if (Test-Path $ShotState) {
    $AutoContext = Join-Path $CaptureDir "strategy_gameplay_context_v0.json"
    $ContextArgs = @(
      "tools\minimap_probe\strategy_gameplay_context_v0.py",
      "--shot-state-json", $ShotState,
      "--output", $AutoContext
    )
    if (-not [string]::IsNullOrWhiteSpace($GameplayContextJson)) {
      $ContextArgs += @("--supplemental-context-json", $GameplayContextJson)
    }
    & $Python @ContextArgs
    if ($LASTEXITCODE -ne 0) { throw "Gameplay-context normalization failed for $CaptureDir" }
    $ContextForCapture = $AutoContext
  } elseif (-not [string]::IsNullOrWhiteSpace($GameplayContextJson)) {
    $ContextForCapture = $GameplayContextJson
  }

  $ArgsList = @(
    "tools\minimap_probe\strategy_field_v0.py",
    "--capture-dir", $CaptureDir,
    "--player-profile-json", $PlayerProfileJson
  )
  if (-not [string]::IsNullOrWhiteSpace($ContextForCapture)) {
    $ArgsList += @("--gameplay-context-json", $ContextForCapture)
  }
  & $Python @ArgsList
  if ($LASTEXITCODE -ne 0) { throw "Strategy Field failed for $CaptureDir" }
}

Write-Host ""
Write-Host "Strategy field replay complete."
Write-Host "No club choice. No aim recommendation. No wind/lie/elevation silently applied."
Write-Host "When ShotState is present, PIN/AIM elevation and lie provenance are carried into Strategy Field automatically."

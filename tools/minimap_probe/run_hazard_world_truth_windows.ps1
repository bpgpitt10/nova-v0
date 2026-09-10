param(
  [string[]]$CurrentRound,
  [string[]]$CaptureRoot,
  [string[]]$GeometryJson,
  [string]$LocalLow,
  [string]$OutputRoot = "tools\minimap_probe\output",
  [double]$NearTolerance = 3.0,
  [switch]$NoZip
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

$ArgsList = @(
  "tools\minimap_probe\hazard_world_truth.py",
  "--output-root", $OutputRoot,
  "--near-tolerance", "$NearTolerance"
)
if ($LocalLow) { $ArgsList += @("--locallow", $LocalLow) }
if ($CurrentRound) {
  foreach ($Path in $CurrentRound) { $ArgsList += @("--current-round", $Path) }
}
if ($CaptureRoot) {
  foreach ($Path in $CaptureRoot) { $ArgsList += @("--capture-root", $Path) }
}
if ($GeometryJson) {
  foreach ($Path in $GeometryJson) { $ArgsList += @("--geometry-json", $Path) }
}
if ($NoZip) { $ArgsList += "--no-zip" }

Write-Host "GSPro Hazard World Truth v0"
Write-Host "READ ONLY. Synthetic gimme closures are excluded from physical truth."
Write-Host "Unity asset coordinates remain diagnostic-only until world transforms are proven."
Write-Host ""
& $Python @ArgsList
exit $LASTEXITCODE

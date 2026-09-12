param(
  [string[]]$CaptureRoot = @(),
  [string[]]$CaptureDir = @(),
  [int]$Latest = 0,
  [string]$Model = "gpt-5.6-luna",
  [string]$SamModel = "facebook/sam2.1-hiera-tiny",
  [string]$Device = "auto",
  [switch]$Force
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

if (-not $CaptureRoot -and -not $CaptureDir) {
  $CaptureRoot = @((Join-Path $PSScriptRoot "output"))
}

$ArgsList = @(
  "tools\minimap_probe\fairway_surface_shadow_luna.py",
  "--model", $Model,
  "--sam-model", $SamModel,
  "--device", $Device,
  "--latest", "$Latest"
)
foreach ($Path in $CaptureRoot) { if ($Path) { $ArgsList += @("--capture-root", $Path) } }
foreach ($Path in $CaptureDir) { if ($Path) { $ArgsList += @("--capture-dir", $Path) } }
if ($Force) { $ArgsList += "--force" }

Write-Host "Looper Fairway Surface Shadow v0"
Write-Host "OFFLINE SAVED-CAPTURE MODE. No GSPro input. Strategy authority OFF."
Write-Host "Luna semantic localization -> Gemini fallback -> SAM2 edge -> tee/pin topology QA."
Write-Host "Par 3 no-fairway is an allowed result."
Write-Host ""
& $Python @ArgsList
exit $LASTEXITCODE

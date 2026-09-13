param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [string]$CourseKey = "",
  [string]$RoundId = "",
  [int]$Latest = 18,
  [string]$Model = "gpt-5.6-luna",
  [string]$SamModel = "facebook/sam2.1-hiera-tiny",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$VenvRoot = Join-Path $PSScriptRoot ".venv"
$Python = Join-Path $VenvRoot "Scripts\python.exe"
if (-not (Test-Path $Python)) {
  Write-Host "Creating isolated minimap-probe Python environment..."
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 -m venv $VenvRoot
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    & python -m venv $VenvRoot
  } else {
    throw "Python was not found."
  }
}

function Test-PythonImport([string]$Code) {
  $prior = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & $Python -c $Code 2>$null
  $exit = $LASTEXITCODE
  $ErrorActionPreference = $prior
  return ($exit -eq 0)
}

Write-Host "Bunker Recall v1 preflight"
if (-not (Test-PythonImport "import cv2, numpy")) {
  Write-Host "Installing base minimap-probe dependencies..."
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements.txt"
  if ($LASTEXITCODE -ne 0) { throw "Base minimap-probe dependency installation failed." }
}

if (-not (Test-PythonImport "import torch, torchvision; from transformers import Sam2Model, Sam2Processor; from PIL import Image")) {
  Write-Host "Installing SAM2 dependencies..."
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements_sam2.txt"
  if ($LASTEXITCODE -ne 0) { throw "SAM2 dependency installation failed." }
}

& $Python -m pip check
if ($LASTEXITCODE -ne 0) { throw "Isolated minimap-probe environment has broken requirements." }

if (-not $env:OPENAI_API_KEY) {
  throw "OPENAI_API_KEY is not available in this PowerShell session."
}

$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

Write-Host "Running local bunker recall regression tests before any API calls..."
& $Python "tools\minimap_probe\test_bunker_recall_v1.py"
if ($LASTEXITCODE -ne 0) { throw "Bunker recall regression tests failed; no semantic API calls were made." }

$ArgsList = @(
  "tools\minimap_probe\bunker_recall_v1.py",
  "--output-root", $OutputRoot,
  "--latest", "$Latest",
  "--model", $Model,
  "--sam-model", $SamModel
)
if ($CourseKey) { $ArgsList += @("--course-key", $CourseKey) }
if ($RoundId) { $ArgsList += @("--round-id", $RoundId) }
if ($Force) { $ArgsList += "--force" }

Write-Host ""
Write-Host "Running recall-first bunker replay on the latest saved tee captures..."
Write-Host "GSPro input: NONE | Fairway redraw: NONE | Strategy authority: OFF"
& $Python @ArgsList
exit $LASTEXITCODE

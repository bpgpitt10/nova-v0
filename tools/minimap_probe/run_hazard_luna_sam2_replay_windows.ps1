param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [int]$Latest = 4,
  [string]$SamModel = "facebook/sam2.1-hiera-tiny"
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

& $Python -c "import cv2, numpy" 2>$null
if ($LASTEXITCODE -ne 0) {
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements.txt"
  if ($LASTEXITCODE -ne 0) { throw "Base minimap-probe dependency installation failed." }
}

& $Python -c "import torch; from transformers import Sam2Model, Sam2Processor; from PIL import Image" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Installing local SAM2 field-lab dependencies. First run can take a while."
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements_sam2.txt"
  if ($LASTEXITCODE -ne 0) { throw "SAM2 dependency installation failed." }
}

Write-Host ""
Write-Host "Looper saved Luna boxes -> local SAM2"
Write-Host "NO OpenAI/Gemini API calls. NO GSPro input. Strategy authority OFF."
& $Python "tools\minimap_probe\hazard_luna_sam2_replay.py" `
  --output-root $OutputRoot `
  --latest $Latest `
  --sam-model $SamModel
exit $LASTEXITCODE

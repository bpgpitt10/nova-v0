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
  if ($LASTEXITCODE -ne 0) { throw "Could not create Python environment." }
}

function Test-PythonImport {
  param([Parameter(Mandatory=$true)][string]$Code)
  $PreviousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "SilentlyContinue"
    & $Python -c $Code 2>$null
    return ($LASTEXITCODE -eq 0)
  } finally {
    $ErrorActionPreference = $PreviousPreference
  }
}

Write-Host "Checking fairway runtime dependencies..."
$BaseReady = Test-PythonImport "import cv2, numpy"
if (-not $BaseReady) {
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements.txt"
  if ($LASTEXITCODE -ne 0) { throw "Base minimap-probe dependency installation failed." }
}

$SamReady = Test-PythonImport "import torch, torchvision; from transformers import Sam2Model, Sam2Processor; from PIL import Image"
if (-not $SamReady) {
  Write-Host "Installing/updating SAM2 + torchvision field-lab dependencies..."
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements_sam2.txt"
  if ($LASTEXITCODE -ne 0) { throw "SAM2 field-lab dependency installation failed." }
  $SamReady = Test-PythonImport "import torch, torchvision; from transformers import Sam2Model, Sam2Processor; from PIL import Image"
  if (-not $SamReady) { throw "SAM2 dependencies installed but the import check still fails." }
}

Write-Host "Segmentation runtime:"
& $Python -c "import torch, torchvision; print('  torch=' + torch.__version__); print('  torchvision=' + torchvision.__version__); print('  cuda=' + str(torch.cuda.is_available())); print('  gpu=' + (torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU fallback'))"
if ($LASTEXITCODE -ne 0) { throw "Could not inspect segmentation runtime." }

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

Write-Host ""
Write-Host "Looper Fairway Surface Shadow v0"
Write-Host "OFFLINE SAVED-CAPTURE MODE. No GSPro input. Strategy authority OFF."
Write-Host "Luna semantic localization -> Gemini fallback -> SAM2 edge -> tee/pin topology QA."
Write-Host "Par 3 no-fairway is an allowed result."
Write-Host ""
& $Python @ArgsList
exit $LASTEXITCODE

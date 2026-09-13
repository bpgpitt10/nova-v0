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

$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

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

function Invoke-PythonChecked {
  param(
    [Parameter(Mandatory=$true)][string[]]$Arguments,
    [Parameter(Mandatory=$true)][string]$FailureMessage
  )
  $PreviousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $Python @Arguments
    $Code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $PreviousPreference
  }
  if ($Code -ne 0) { throw $FailureMessage }
}

$PythonVersion = (& $Python -c "import sys; print(sys.version.split()[0])").Trim()
Write-Host "Fairway runtime preflight"
Write-Host "  python=$PythonVersion"

Write-Host "Checking base probe dependencies..."
$BaseReady = Test-PythonImport "import cv2, numpy"
if (-not $BaseReady) {
  Invoke-PythonChecked -Arguments @(
    "-m", "pip", "install", "--disable-pip-version-check",
    "-r", "tools\minimap_probe\requirements.txt"
  ) -FailureMessage "Base minimap-probe dependency installation failed."
}

$SamReady = Test-PythonImport "import torch, torchvision; from transformers import Sam2Model, Sam2Processor; assert torch.__version__.split('+')[0] == '2.14.0'; assert torchvision.__version__.split('+')[0] == '0.29.0'"
if (-not $SamReady) {
  Write-Host "Installing/repairing matched SAM2 runtime (torch 2.14.0 + torchvision 0.29.0)..."
  Invoke-PythonChecked -Arguments @(
    "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "--force-reinstall",
    "-r", "tools\minimap_probe\requirements_sam2.txt"
  ) -FailureMessage "SAM2 field-lab dependency installation failed."
  $SamReady = Test-PythonImport "import torch, torchvision; from transformers import Sam2Model, Sam2Processor; assert torch.__version__.split('+')[0] == '2.14.0'; assert torchvision.__version__.split('+')[0] == '0.29.0'"
  if (-not $SamReady) { throw "SAM2 dependencies installed but the matched runtime import check still fails." }
}

Write-Host "Checking isolated environment consistency..."
Invoke-PythonChecked -Arguments @("-m", "pip", "check") -FailureMessage "Python dependency consistency check failed."

Invoke-PythonChecked -Arguments @(
  "-c",
  "import torch, torchvision; print('  torch=' + torch.__version__); print('  torchvision=' + torchvision.__version__); print('  cuda=' + str(torch.cuda.is_available())); print('  gpu=' + (torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU fallback'))"
) -FailureMessage "Could not inspect segmentation runtime."

Write-Host "Running local fairway regression tests before any API calls..."
Push-Location $PSScriptRoot
try {
  Invoke-PythonChecked -Arguments @(
    "-m", "unittest", "test_fairway_surface_shadow", "test_fairway_semantic_provider", "-v"
  ) -FailureMessage "Fairway regression tests failed; no semantic API calls were made."
} finally {
  Pop-Location
}

Write-Host "Running one end-to-end SAM2 box-prompt preflight before any API calls..."
$SamPreflight = @"
import numpy as np
import torch
from PIL import Image
from transformers import Sam2Model, Sam2Processor
mid = '$SamModel'
device = 'cuda' if torch.cuda.is_available() and '$Device' != 'cpu' else 'cpu'
processor = Sam2Processor.from_pretrained(mid)
model = Sam2Model.from_pretrained(mid).to(device)
model.eval()
image = Image.fromarray(np.zeros((64, 64, 3), dtype=np.uint8), mode='RGB')
inputs = processor(images=image, input_boxes=[[[8.0, 8.0, 56.0, 56.0]]], return_tensors='pt').to(device)
with torch.no_grad():
    outputs = model(**inputs, multimask_output=True)
masks = processor.post_process_masks(outputs.pred_masks.cpu(), inputs['original_sizes'])[0]
assert masks.shape[-2:] == (64, 64), masks.shape
print('  SAM2 box-prompt preflight=OK | device=' + device + ' | masks=' + str(tuple(masks.shape)))
"@
Invoke-PythonChecked -Arguments @("-c", $SamPreflight) -FailureMessage "SAM2 model/processor preflight failed; no semantic API calls were made."

if (-not $env:OPENAI_API_KEY -and -not $env:GEMINI_API_KEY) {
  throw "Neither OPENAI_API_KEY nor GEMINI_API_KEY is available in this PowerShell session."
}
Write-Host "Semantic providers: Luna=$([bool]$env:OPENAI_API_KEY) | Gemini fallback=$([bool]$env:GEMINI_API_KEY)"

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
Write-Host "Luna semantic localization -> Gemini fallback -> shared SAM2 edge -> tee/pin topology QA."
Write-Host "Par 3 no-fairway is an allowed result."
Write-Host ""
Invoke-PythonChecked -Arguments $ArgsList -FailureMessage "Fairway replay exited with an error."

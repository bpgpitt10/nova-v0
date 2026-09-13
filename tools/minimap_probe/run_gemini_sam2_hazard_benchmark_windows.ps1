param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [string[]]$CaptureDir,
  [int]$Latest = 5,
  [string]$GeminiModel = "gemini-3.1-flash-lite",
  [string]$SamModel = "facebook/sam2.1-hiera-tiny",
  [ValidateSet("auto","cuda","cpu")][string]$Device = "auto",
  [double]$Timeout = 90,
  [switch]$AllowHeatmap,
  [switch]$ReuseBoxes,
  [switch]$SkipTests,
  [switch]$NoReviewZip
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

if (-not $env:GEMINI_API_KEY) {
  throw "GEMINI_API_KEY is not available in this PowerShell session. The launcher will never print the key."
}

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

Write-Host "Checking base probe dependencies..."
$BaseReady = Test-PythonImport "import cv2, numpy"
if (-not $BaseReady) {
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements.txt"
  if ($LASTEXITCODE -ne 0) { throw "Base minimap-probe dependency installation failed." }
}

Write-Host "Checking SAM2 field-lab dependencies..."
$SamReady = Test-PythonImport "import torch, torchvision; from transformers import Sam2Model, Sam2Processor; from PIL import Image"
if (-not $SamReady) {
  Write-Host "Installing PyTorch + Torchvision + Transformers SAM2 support into the isolated probe environment..."
  Write-Host "This may take a while on the first run and downloads model/runtime packages only for the field lab."
  & $Python -m pip install --disable-pip-version-check -r "tools\minimap_probe\requirements_sam2.txt"
  if ($LASTEXITCODE -ne 0) { throw "SAM2 field-lab dependency installation failed." }
  $SamReady = Test-PythonImport "import torch, torchvision; from transformers import Sam2Model, Sam2Processor; from PIL import Image"
  if (-not $SamReady) { throw "SAM2 dependencies installed but the import check still fails." }
}

Write-Host ""
Write-Host "Segmentation runtime:"
& $Python -c "import torch, torchvision; print('  torch=' + torch.__version__); print('  torchvision=' + torchvision.__version__); print('  cuda=' + str(torch.cuda.is_available())); print('  gpu=' + (torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU fallback'))"
if ($LASTEXITCODE -ne 0) { throw "Could not inspect PyTorch runtime." }

if (-not $SkipTests) {
  Write-Host ""
  Write-Host "Running Step 6 regression tests before the benchmark..."
  & $Python -m unittest tools.minimap_probe.test_hazard_prompt_segment -v
  if ($LASTEXITCODE -ne 0) { throw "Step 6 regression tests failed; benchmark was not started." }
}

$ArgsList = @(
  "tools\minimap_probe\hazard_gemini_sam2_benchmark.py",
  "--output-root", $OutputRoot,
  "--latest", "$Latest",
  "--gemini-model", $GeminiModel,
  "--sam-model", $SamModel,
  "--device", $Device,
  "--timeout", "$Timeout"
)
if ($CaptureDir) {
  foreach ($Path in $CaptureDir) { $ArgsList += @("--capture-dir", $Path) }
}
if ($AllowHeatmap) { $ArgsList += "--allow-heatmap" }
if ($ReuseBoxes) { $ArgsList += "--reuse-boxes" }
if ($NoReviewZip) { $ArgsList += "--no-review-zip" }

Write-Host ""
Write-Host "Gemini -> SAM2 Hazard Benchmark v0"
Write-Host "Gemini: $GeminiModel | SAM2: $SamModel | device: $Device"
Write-Host "Saved captures only. No GSPro keypresses. Strategy authority: OFF."
Write-Host "Heatmap-only input: $($(if ($AllowHeatmap) {'ALLOWED FOR DIAGNOSTICS'} else {'REFUSED'}))"
Write-Host ""
& $Python @ArgsList
exit $LASTEXITCODE

param(
  [int]$Monitor = 1,
  [string]$Roi = "",
  [string]$LieRoi = "",
  [string]$Tesseract = "",
  [string]$GsproDir = "",
  [switch]$DeepDebug
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

$argsList = @(
  (Join-Path $Here "probe_approach_v14.py"),
  "--monitor", "$Monitor"
)
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($LieRoi) { $argsList += @("--lie-roi", $LieRoi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($GsproDir) { $argsList += @("--gspro-dir", $GsproDir) }
if ($DeepDebug) { $argsList += "--deep-debug" }

Write-Host "Running GSPro POST-SHOT state probe v1.4 once."
Write-Host "Position: structured currentRound world coordinates."
Write-Host "Dynamic sensors: PIN + lie only. AIM and post-shot minimap registration are retired."
& $Python @argsList
exit $LASTEXITCODE

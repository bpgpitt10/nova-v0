param(
  [string]$CaptureDir = "",
  [string]$Image = "",
  [string]$HoleModel = "",
  [double]$Corridor = 40,
  [double]$MinConfidence = 0.45,
  [int]$MinAreaPx = 12,
  [switch]$SelfTest,
  [switch]$Json
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
  (Join-Path $Here "probe_bunkers.py"),
  "--corridor", "$Corridor",
  "--min-confidence", "$MinConfidence",
  "--min-area-px", "$MinAreaPx"
)
if ($CaptureDir) { $argsList += @("--capture-dir", $CaptureDir) }
if ($Image) { $argsList += @("--image", $Image) }
if ($HoleModel) { $argsList += @("--hole-model", $HoleModel) }
if ($SelfTest) { $argsList += "--self-test" }
if ($Json) { $argsList += "--json" }

Write-Host "Running GSPro bunker identification probe v0."
Write-Host "SAFE: offline/read-only. No GSPro focus, keys, zoom, or HoleModel mutation."
& $Python @argsList
exit $LASTEXITCODE

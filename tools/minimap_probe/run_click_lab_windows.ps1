param(
  [int]$Monitor = 1,
  [double]$Right,
  [double]$Forward,
  [string]$BallCourse = "",
  [string]$PinCourse = "",
  [string]$TargetCourse = "",
  [Nullable[double]]$Distance = $null,
  [string]$Roi = "",
  [string]$Tesseract = "",
  [switch]$Click,
  [switch]$RunProof
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

if ($RunProof) {
  Write-Host "Running Click Lab transform proof..."
  & $Python (Join-Path $Here "click_lab_transform_proof.py")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host ""
}

$argsList = @(
  (Join-Path $Here "click_lab.py"),
  "--monitor", "$Monitor"
)

$AbsoluteMode = $BallCourse -or $PinCourse -or $TargetCourse
if ($AbsoluteMode) {
  if (-not ($BallCourse -and $PinCourse -and $TargetCourse)) {
    throw "Absolute mode requires -BallCourse, -PinCourse, and -TargetCourse together."
  }
  $argsList += @(
    "--ball-course", $BallCourse,
    "--pin-course", $PinCourse,
    "--target-course", $TargetCourse
  )
} else {
  if (-not $PSBoundParameters.ContainsKey("Right") -or -not $PSBoundParameters.ContainsKey("Forward")) {
    throw "Supply -Right and -Forward, or all three absolute course coordinates."
  }
  $argsList += @("--right", "$Right", "--forward", "$Forward")
}

if ($Distance -ne $null) { $argsList += @("--distance", "$Distance") }
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Tesseract) { $argsList += @("--tesseract", $Tesseract) }
if ($Click) { $argsList += "--click" }

Write-Host "GSPro Minimap Click Lab"
Write-Host "-----------------------"
if ($Click) {
  Write-Host "MODE: ONE-SHOT CLICK ENABLED"
  Write-Host "The lab will refuse input unless GSPro, markers, ROI, and target pixel all validate."
} else {
  Write-Host "MODE: PREVIEW ONLY — GSPro will not receive mouse input."
}
Write-Host "Minimap zoom is never changed by this harness."
Write-Host "Evidence is saved under tools\minimap_probe\output\click_lab."
Write-Host ""

& $Python @argsList
exit $LASTEXITCODE

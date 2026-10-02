param(
  [int]$Monitor = 1,
  [switch]$CalibrateTee,
  [int]$Par,
  [Nullable[double]]$Distance = $null,
  [Nullable[double]]$Forward = $null,
  [Nullable[double]]$Right = $null,
  [string]$TargetCanonical = "",
  [string]$TeeCourse = "",
  [string]$PinCourse = "",
  [string]$TargetCourse = "",
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

# Resolve Tesseract once in the Windows launcher so the Python OCR path never
# depends on shell PATH configuration. Explicit -Tesseract wins.
if (-not $Tesseract) {
  $TesseractCommand = Get-Command tesseract.exe -ErrorAction SilentlyContinue
  if ($TesseractCommand) {
    $Tesseract = $TesseractCommand.Source
  } else {
    $Candidates = @(
      "C:\Program Files\Tesseract-OCR\tesseract.exe",
      "C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
      (Join-Path $env:LOCALAPPDATA "Programs\Tesseract-OCR\tesseract.exe")
    )
    foreach ($Candidate in $Candidates) {
      if (Test-Path $Candidate) {
        $Tesseract = $Candidate
        break
      }
    }
  }
}

if (-not $Tesseract -or -not (Test-Path $Tesseract)) {
  throw "Tesseract OCR was not found. Install Tesseract OCR for Windows or rerun with -Tesseract 'C:\path\to\tesseract.exe'."
}
Write-Host "Tesseract: $Tesseract"

if ($RunProof) {
  & $Python (Join-Path $Here "waypoint_scale_proof.py")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Python (Join-Path $Here "minimap_zoom_registration_proof.py")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $Python (Join-Path $Here "auto_aim_transform_proof.py")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$argsList = @(
  (Join-Path $Here "auto_aim_click_runner.py"),
  "--monitor", "$Monitor",
  "--tesseract", $Tesseract
)
if ($Roi) { $argsList += @("--roi", $Roi) }
if ($Distance -ne $null) { $argsList += @("--distance", "$Distance") }

if ($CalibrateTee) {
  if (-not $PSBoundParameters.ContainsKey("Par")) { throw "-CalibrateTee requires -Par." }
  if ($Click) { throw "Tee calibration never clicks; remove -Click." }
  $argsList += @("--calibrate-tee", "--par", "$Par")
  Write-Host "AUTO AIM: TEE CALIBRATION ONLY - no mouse input"
} else {
  if ($TargetCanonical) {
    $argsList += @("--target-canonical", $TargetCanonical)
  } elseif ($TeeCourse -or $PinCourse -or $TargetCourse) {
    if (-not ($TeeCourse -and $PinCourse -and $TargetCourse)) { throw "Course mode requires -TeeCourse, -PinCourse, and -TargetCourse together." }
    $argsList += @("--tee-course", $TeeCourse, "--pin-course", $PinCourse, "--target-course", $TargetCourse)
  } else {
    if ($Forward -eq $null -or $Right -eq $null) { throw "Supply -Forward and -Right, -TargetCanonical, or all three course points." }
    $argsList += @("--forward", "$Forward", "--right", "$Right")
  }
  if ($Click) {
    $argsList += "--click"
    Write-Host "AUTO AIM: ONE-SHOT CLICK ENABLED"
  } else {
    Write-Host "AUTO AIM: PREVIEW ONLY - no mouse input"
  }
}

Write-Host "Evidence: tools\minimap_probe\output\auto_aim"
& $Python @argsList
exit $LASTEXITCODE

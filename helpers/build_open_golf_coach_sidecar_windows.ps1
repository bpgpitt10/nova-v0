$ErrorActionPreference = "Stop"

$root = Split-Path -Path $PSScriptRoot -Parent
$helperScript = Join-Path $root "helpers\open_golf_coach_helper.py"
$binDir = Join-Path $root "src-tauri\binaries"
$distDir = Join-Path $root "helpers\dist"
$buildDir = Join-Path $root "helpers\build"
$specDir = Join-Path $root "helpers"
$venvDir = Join-Path $root "helpers\.venv-open-golf-coach-sidecar-win"

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "ARM64") {
  $targetTriple = "aarch64-pc-windows-msvc"
} else {
  $targetTriple = "x86_64-pc-windows-msvc"
}

$outName = "open-golf-coach-helper-$targetTriple"
$outExe = "$outName.exe"

if (!(Test-Path $venvDir)) {
  python -m venv $venvDir
}

$venvPython = Join-Path $venvDir "Scripts\python.exe"
if (!(Test-Path $venvPython)) {
  throw "Failed to locate virtualenv python at $venvPython"
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install --upgrade pyinstaller opengolfcoach
& $venvPython -m PyInstaller --noconfirm --onefile --name $outName $helperScript `
  --distpath $distDir `
  --workpath $buildDir `
  --specpath $specDir

New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Copy-Item -Path (Join-Path $distDir $outExe) -Destination (Join-Path $binDir $outExe) -Force

Write-Host "Built OpenGolfCoach sidecar:" (Join-Path $binDir $outExe)

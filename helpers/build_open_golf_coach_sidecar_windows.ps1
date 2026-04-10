$ErrorActionPreference = "Stop"

$root = Split-Path -Path $PSScriptRoot -Parent
$helperScript = Join-Path $root "helpers\open_golf_coach_helper.py"
$binDir = Join-Path $root "src-tauri\binaries"
$distDir = Join-Path $root "helpers\dist"
$buildDir = Join-Path $root "helpers\build"
$specDir = Join-Path $root "helpers"

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "ARM64") {
  $targetTriple = "aarch64-pc-windows-msvc"
} else {
  $targetTriple = "x86_64-pc-windows-msvc"
}

$outName = "open-golf-coach-helper-$targetTriple"
$outExe = "$outName.exe"

python -m pip install --upgrade pyinstaller
python -m PyInstaller --noconfirm --onefile --name $outName $helperScript `
  --distpath $distDir `
  --workpath $buildDir `
  --specpath $specDir

New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Copy-Item -Path (Join-Path $distDir $outExe) -Destination (Join-Path $binDir $outExe) -Force

Write-Host "Built OpenGolfCoach sidecar:" (Join-Path $binDir $outExe)

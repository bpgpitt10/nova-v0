$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:LOCALAPPDATA "Looper\Companion"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "LooperCompanion"

Get-Process -Name "LooperCompanion" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
if (Test-Path $installDir) {
  Remove-Item -Path $installDir -Recurse -Force
}

Write-Host "Looper Companion removed."

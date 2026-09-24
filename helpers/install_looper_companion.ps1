$ErrorActionPreference = "Stop"

$sourceExe = Join-Path $PSScriptRoot "LooperCompanion.exe"
if (!(Test-Path $sourceExe)) {
  throw "LooperCompanion.exe was not found next to this installer."
}

$installDir = Join-Path $env:LOCALAPPDATA "Looper\Companion"
$installExe = Join-Path $installDir "LooperCompanion.exe"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "LooperCompanion"

New-Item -ItemType Directory -Path $installDir -Force | Out-Null

# Stop an older copy before replacing it. This is per-user and does not need admin.
Get-Process -Name "LooperCompanion" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 250
Copy-Item -Path $sourceExe -Destination $installExe -Force

if (!(Test-Path $runKey)) {
  New-Item -Path $runKey -Force | Out-Null
}
Set-ItemProperty -Path $runKey -Name $runName -Value ('"' + $installExe + '"')

Start-Process -FilePath $installExe -WindowStyle Hidden

$healthy = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 2
    if ($health.service -eq "open-golf-coach-helper" -and $health.status -eq "ok") {
      $healthy = $true
      break
    }
  } catch {}
}

if (!$healthy) {
  throw "Looper Companion installed, but its localhost health check did not come online at http://127.0.0.1:8787/health."
}

Write-Host "Looper Companion installed and running. It will start automatically when you sign in to Windows."

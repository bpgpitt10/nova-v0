param(
  [string]$SessionId = "",
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$DefaultOutputRoot = Join-Path $Here "output"
$Root = if ($OutputRoot) { $OutputRoot } else { $DefaultOutputRoot }
$StateFile = Join-Path $Root "round_watch_state.json"
$VenvPython = Join-Path $Here ".venv\Scripts\python.exe"
$Python = if (Test-Path $VenvPython) { $VenvPython } else { "python" }

$argsList = @(
  (Join-Path $Here "package_partial_validation_v0.py"),
  "--output-root", $Root,
  "--state-file", $StateFile
)
if ($SessionId) {
  $argsList += @("--session-id", $SessionId)
}

Write-Host "Packaging latest Looper partial validation watcher session..."
& $Python @argsList
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$Latest = Join-Path $Root "latest_partial_validation.zip"
Write-Host ""
Write-Host "READY TO UPLOAD: $Latest"
exit 0

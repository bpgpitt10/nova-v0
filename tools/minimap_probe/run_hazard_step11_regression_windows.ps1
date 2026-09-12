param(
  [string]$OutputRoot = "tools\minimap_probe\output",
  [string]$Manifest = "tools\minimap_probe\regression\step11_20260911_farmlinks.json"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$VenvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$Python = if (Test-Path $VenvPython) { $VenvPython } else { "python" }
$Summary = Join-Path $OutputRoot "step11_20260911_regression_result.json"

Write-Host "Looper Step 11 saved field regression"
Write-Host "READ ONLY: no GSPro input, no model/API calls, no strategy promotion."
& $Python "tools\minimap_probe\hazard_step11_regression_suite.py" `
  --manifest $Manifest `
  --output-root $OutputRoot `
  --json-out $Summary
exit $LASTEXITCODE

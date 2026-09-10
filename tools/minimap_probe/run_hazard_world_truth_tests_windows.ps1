$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $RepoRoot

$Python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
  if (Get-Command py -ErrorAction SilentlyContinue) { $Python = "py" }
  elseif (Get-Command python -ErrorAction SilentlyContinue) { $Python = "python" }
  else { throw "Python was not found." }
}

& $Python -m unittest tools.minimap_probe.test_hazard_world_truth -v
exit $LASTEXITCODE

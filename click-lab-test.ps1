param(
  [switch]$Click
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $Root "tools\minimap_probe\run_next_click_lab_test.ps1"

if (-not (Test-Path $Runner)) {
  throw "Click Lab runner not found: $Runner"
}

if ($Click) {
  & $Runner -Click
} else {
  & $Runner
}

exit $LASTEXITCODE

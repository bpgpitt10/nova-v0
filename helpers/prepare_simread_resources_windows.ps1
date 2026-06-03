param(
  [string]$SimReadRoot = "C:\Users\User\Documents\SimRead",
  [string]$NodeExePath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$artifactDir = Join-Path $SimReadRoot "artifacts\simread-helper"
$helperResourceDir = Join-Path $repoRoot "src-tauri\resources\simread-helper"
$nodeResourceDir = Join-Path $repoRoot "src-tauri\resources\node"

if (-not (Test-Path $artifactDir)) {
  throw "SimRead helper artifact not found: $artifactDir. Run 'npm run bundle:simread-helper' in $SimReadRoot first."
}

$cliPath = Join-Path $artifactDir "dist\simread\cli.js"
$packageJsonPath = Join-Path $artifactDir "package.json"
$nodeModulesPath = Join-Path $artifactDir "node_modules"

if (-not (Test-Path $cliPath)) {
  throw "SimRead helper entrypoint not found: $cliPath"
}

if (-not (Test-Path $packageJsonPath)) {
  throw "SimRead helper package.json not found: $packageJsonPath"
}

if (-not (Test-Path $nodeModulesPath)) {
  throw "SimRead helper node_modules directory not found: $nodeModulesPath"
}

if (-not $NodeExePath.Trim()) {
  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $NodeExePath = $nodeCommand.Source
}

if (-not (Test-Path $NodeExePath)) {
  throw "node.exe not found: $NodeExePath"
}

New-Item -ItemType Directory -Force -Path $helperResourceDir | Out-Null
New-Item -ItemType Directory -Force -Path $nodeResourceDir | Out-Null

Get-ChildItem -LiteralPath $helperResourceDir -Force |
  Where-Object { $_.Name -notin @(".gitkeep", "README.md") } |
  Remove-Item -Recurse -Force

Get-ChildItem -LiteralPath $artifactDir -Force |
  Copy-Item -Destination $helperResourceDir -Recurse -Force

Copy-Item -LiteralPath $NodeExePath -Destination (Join-Path $nodeResourceDir "node.exe") -Force

Write-Host "Prepared SimRead helper resource: $helperResourceDir"
Write-Host "Prepared bundled Node runtime: $(Join-Path $nodeResourceDir "node.exe")"

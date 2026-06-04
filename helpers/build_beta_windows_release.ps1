param(
  [string]$SimReadRoot = "C:\Users\User\Documents\SimRead",
  [string]$ReleaseTag = "beta-gspro-hook-v1",
  [string]$GitHubRepository = "bpgpitt10/nova-v0"
)

$ErrorActionPreference = "Stop"

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Parent,
    [Parameter(Mandatory = $true)]
    [string]$Child
  )

  $resolvedParent = [System.IO.Path]::GetFullPath($Parent)
  $resolvedChild = [System.IO.Path]::GetFullPath($Child)
  if (-not $resolvedChild.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside repo root. Parent=$resolvedParent Child=$resolvedChild"
  }
}

if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
  throw "TAURI_SIGNING_PRIVATE_KEY is not set."
}

if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
  throw "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is not set."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageJsonPath = Join-Path $repoRoot "package.json"
$tauriConfigPath = Join-Path $repoRoot "src-tauri\tauri.conf.json"

$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$tauriVersion = [string]$tauriConfig.version
$productName = [string]$tauriConfig.productName

if ([string]::IsNullOrWhiteSpace($version)) {
  throw "package.json version is empty."
}

if ($version -ne $tauriVersion) {
  throw "Version mismatch: package.json is $version, tauri.conf.json is $tauriVersion."
}

if ([string]::IsNullOrWhiteSpace($productName)) {
  throw "tauri.conf.json productName is empty."
}

if (-not (Test-Path -LiteralPath $SimReadRoot)) {
  throw "SimRead root not found: $SimReadRoot"
}

$bundleRoot = Join-Path $repoRoot "src-tauri\target\release\bundle"
Assert-ChildPath -Parent $repoRoot -Child $bundleRoot

$releaseRoot = Join-Path $repoRoot "release\windows\$version"
Assert-ChildPath -Parent $repoRoot -Child $releaseRoot

Write-Host "Building SimRead helper from $SimReadRoot"
Push-Location $SimReadRoot
try {
  Invoke-External npm run bundle:simread-helper
} finally {
  Pop-Location
}

Write-Host "Preparing SimRead resources"
Push-Location $repoRoot
try {
  Invoke-External npm run simread:prepare-resources:windows

  if (Test-Path -LiteralPath $bundleRoot) {
    Write-Host "Removing old bundle output: $bundleRoot"
    Remove-Item -LiteralPath $bundleRoot -Recurse -Force
  }

  Write-Host "Running signed Tauri build"
  Invoke-External npm run tauri:build
} finally {
  Pop-Location
}

$installerFileName = "${productName}_${version}_x64-setup.exe"
$signatureFileName = "$installerFileName.sig"
$nsisOutputDir = Join-Path $bundleRoot "nsis"
$installerPath = Join-Path $nsisOutputDir $installerFileName
$signaturePath = Join-Path $nsisOutputDir $signatureFileName

if (-not (Test-Path -LiteralPath $installerPath)) {
  throw "NSIS installer not found: $installerPath"
}

if (-not (Test-Path -LiteralPath $signaturePath)) {
  throw "NSIS signature not found: $signaturePath"
}

if (Test-Path -LiteralPath $releaseRoot) {
  Write-Host "Cleaning release folder: $releaseRoot"
  Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null

Copy-Item -LiteralPath $installerPath -Destination (Join-Path $releaseRoot $installerFileName) -Force
Copy-Item -LiteralPath $signaturePath -Destination (Join-Path $releaseRoot $signatureFileName) -Force

$signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($signature)) {
  throw "NSIS signature file is empty: $signaturePath"
}

$encodedInstallerFileName = [System.Uri]::EscapeDataString($installerFileName)
$downloadUrl = "https://github.com/$GitHubRepository/releases/download/$ReleaseTag/$encodedInstallerFileName"
$latestJsonPath = Join-Path $releaseRoot "latest.json"

$latestJson = [ordered]@{
  version = $version
  notes = "Windows beta release $ReleaseTag"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $signature
      url = $downloadUrl
    }
  }
}

$latestJson |
  ConvertTo-Json -Depth 10 |
  Set-Content -LiteralPath $latestJsonPath -Encoding UTF8

Write-Host ""
Write-Host "Windows beta release prepared:"
Write-Host "  $releaseRoot"
Get-ChildItem -LiteralPath $releaseRoot -File | ForEach-Object {
  Write-Host "  $($_.Name)"
}

param(
  [string]$OutputRoot = "",
  [int]$Latest = 5,
  [string]$Models = "gemini-3.7-flash,gemini-3.1-flash-lite",
  [int]$Repeats = 1,
  [double]$TimeoutSeconds = 90,
  [switch]$NoReviewZip
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutputRoot) { $OutputRoot = Join-Path $Here "output" }
$Venv = Join-Path $Here ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"

if (-not $env:GEMINI_API_KEY) {
  throw "GEMINI_API_KEY is not visible in this PowerShell process. Close/reopen PowerShell after setting it."
}
Write-Host "Gemini key detected (value will not be printed)."

if (-not (Test-Path $Python)) {
  Write-Host "Creating minimap probe virtual environment..."
  python -m venv $Venv
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r (Join-Path $Here "requirements.txt")
}

Write-Host ""
Write-Host "LOOPER GEMINI HAZARD BENCHMARK"
Write-Host "=============================="
Write-Host "Models:   $Models"
Write-Host "Captures: latest $Latest saved tee captures"
Write-Host "Repeats:  $Repeats"
Write-Host "SAFE: diagnostic shadow only. No GSPro actuation. No strategy authority."
Write-Host ""

& $Python (Join-Path $Here "hazard_vlm_gemini_benchmark.py") `
  --output-root $OutputRoot `
  --latest $Latest `
  --models $Models `
  --repeats $Repeats `
  --timeout-seconds $TimeoutSeconds

$BenchExit = $LASTEXITCODE

if (($BenchExit -eq 0) -and (-not $NoReviewZip)) {
  try {
    $ShareRoot = Join-Path $OutputRoot "gemini_hazard_benchmark_share"
    $ZipPath = Join-Path $OutputRoot "gemini_hazard_benchmark_review.zip"
    if (Test-Path $ShareRoot) { Remove-Item $ShareRoot -Recurse -Force }
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    New-Item -ItemType Directory -Path $ShareRoot | Out-Null

    $Summary = Join-Path $OutputRoot "hazard_vlm_gemini_benchmark_v0.json"
    if (Test-Path $Summary) {
      Copy-Item $Summary (Join-Path $ShareRoot "hazard_vlm_gemini_benchmark_v0.json")
    }

    $captures = Get-ChildItem -Path $OutputRoot -Directory -Filter "tee_capture_*" |
      Sort-Object LastWriteTime |
      Select-Object -Last $Latest

    $sourceNames = @(
      "tee_hazard_safe_minimap.png",
      "tee_canonical_minimap.png",
      "tee_initial_minimap.png",
      "watcher_prelaunch_minimap.png",
      "tee_heatmap_minimap.png"
    )

    foreach ($capture in $captures) {
      $dest = Join-Path $ShareRoot $capture.Name
      New-Item -ItemType Directory -Path $dest | Out-Null
      Get-ChildItem -Path $capture.FullName -File | ForEach-Object {
        if (($_.Name -like "hazard_vlm_*") -or ($sourceNames -contains $_.Name)) {
          Copy-Item $_.FullName (Join-Path $dest $_.Name)
        }
      }
    }

    Compress-Archive -Path (Join-Path $ShareRoot "*") -DestinationPath $ZipPath -Force
    Remove-Item $ShareRoot -Recurse -Force
    Write-Host ""
    Write-Host "Review ZIP: $ZipPath"
    Write-Host "Upload that ZIP to ChatGPT for model-by-model visual review."
  } catch {
    Write-Warning "Benchmark succeeded, but review ZIP packaging failed: $($_.Exception.Message)"
  }
}

exit $BenchExit

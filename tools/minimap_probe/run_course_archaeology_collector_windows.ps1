param(
    [string]$LocalLow = "",
    [string]$GsproRoot = "",
    [string]$CourseFolder = "",
    [string]$OutputRoot = "",
    [double]$MaxCopyMB = 16,
    [double]$MaxFullHashMB = 256,
    [int]$MaxFiles = 10000,
    [switch]$NoZip
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$Collector = Join-Path $ScriptDir "course_archaeology_collector.py"

if (-not (Test-Path $Collector)) {
    throw "Collector not found: $Collector"
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $ScriptDir "output"
}

function Resolve-Python {
    $candidates = @(
        @{ Exe = "py"; Prefix = @("-3") },
        @{ Exe = "python"; Prefix = @() },
        @{ Exe = "python3"; Prefix = @() }
    )

    foreach ($candidate in $candidates) {
        try {
            $cmd = Get-Command $candidate.Exe -ErrorAction Stop
            $probeArgs = @($candidate.Prefix) + @("-c", "import sys; assert sys.version_info >= (3, 9); print(sys.executable)")
            $null = & $cmd.Source @probeArgs 2>$null
            if ($LASTEXITCODE -eq 0) {
                return @{ Exe = $cmd.Source; Prefix = $candidate.Prefix }
            }
        }
        catch {
            # Try next candidate.
        }
    }

    throw "Python 3.9+ was not found. The collector uses only the Python standard library; no pip installs are required."
}

$Python = Resolve-Python

Write-Host ""
Write-Host "GSPro Course Archaeology Collector v0"
Write-Host "====================================="
Write-Host "Read-only forensic collection. No GSPro actuation."
Write-Host "Repo: $RepoRoot"
Write-Host "Python: $($Python.Exe)"
Write-Host ""

$argsList = @($Python.Prefix) + @(
    $Collector,
    "--output-root", $OutputRoot,
    "--max-copy-mb", $MaxCopyMB,
    "--max-full-hash-mb", $MaxFullHashMB,
    "--max-files", $MaxFiles
)

if (-not [string]::IsNullOrWhiteSpace($LocalLow)) {
    $argsList += @("--locallow", $LocalLow)
}
if (-not [string]::IsNullOrWhiteSpace($GsproRoot)) {
    $argsList += @("--gspro-root", $GsproRoot)
}
if (-not [string]::IsNullOrWhiteSpace($CourseFolder)) {
    $argsList += @("--course-folder", $CourseFolder)
}
if ($NoZip) {
    $argsList += "--no-zip"
}

& $Python.Exe @argsList
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    Write-Warning "Collector exited with code $exitCode. Partial output may still be available under $OutputRoot."
    exit $exitCode
}

Write-Host ""
Write-Host "Collection complete. Upload the Review ZIP printed above."

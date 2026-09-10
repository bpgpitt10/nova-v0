param()

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
Push-Location $RepoRoot
try {
    $python = $null
    foreach ($candidate in @("py", "python", "python3")) {
        try {
            $cmd = Get-Command $candidate -ErrorAction Stop
            if ($candidate -eq "py") {
                & $cmd.Source -3 -c "import sys; assert sys.version_info >= (3,9)" 2>$null
                if ($LASTEXITCODE -eq 0) { $python = @{Exe=$cmd.Source; Prefix=@("-3")}; break }
            } else {
                & $cmd.Source -c "import sys; assert sys.version_info >= (3,9)" 2>$null
                if ($LASTEXITCODE -eq 0) { $python = @{Exe=$cmd.Source; Prefix=@()}; break }
            }
        } catch {}
    }
    if ($null -eq $python) { throw "Python 3.9+ not found." }

    $env:PYTHONPATH = (Join-Path $RepoRoot "tools\minimap_probe")
    & $python.Exe @($python.Prefix) -m unittest tools.minimap_probe.test_course_archaeology_collector -v
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}

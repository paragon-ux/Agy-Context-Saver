# Agy-Context-Saver Universal Installer for Windows
# Validates Node.js >= 22.0.0 and delegates installation, status, and uninstall to scripts/install-register.mjs

$ErrorActionPreference = "Stop"

# Dynamic Node executable resolution
$NodeCmdObj = Get-Command node -ErrorAction SilentlyContinue
$NodeExe = if ($NodeCmdObj -and $NodeCmdObj.Source) {
    $NodeCmdObj.Source
} elseif ($env:ProgramFiles -and (Test-Path (Join-Path $env:ProgramFiles "nodejs\node.exe"))) {
    Join-Path $env:ProgramFiles "nodejs\node.exe"
} elseif (Test-Path "C:\Program Files\nodejs\node.exe") {
    "C:\Program Files\nodejs\node.exe"
} elseif (${env:ProgramFiles(x86)} -and (Test-Path (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"))) {
    Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"
} else {
    $null
}

if (-not $NodeExe) {
    Write-Error "Node.js (>= 22.0.0) is required, but 'node' was not found on PATH or in standard Program Files install locations. Please install Node.js 22 or newer (https://nodejs.org/ or via nvm/fnm/volta) and re-run .\install.ps1." -ErrorAction Continue
    exit 1
}

$NodeVersion = ((& $NodeExe -v 2>$null) | Out-String).Trim()
if (-not ($NodeVersion -match '^v?(\d+)') -or ([int]$Matches[1] -lt 22)) {
    $DisplayNodeVersion = if ($NodeVersion) { $NodeVersion } else { "unknown" }
    Write-Error "Unsupported Node.js version $DisplayNodeVersion. Agy-Context-Saver requires Node.js >= 22.0.0. Please upgrade Node.js (https://nodejs.org/ or via nvm/fnm/volta) and re-run .\install.ps1." -ErrorAction Continue
    exit 1
}

# Delegate to cross-platform registration engine (plugin link, single-surface global hooks, shims, RTK, and legacy node.cmd cleanup)
$RegisterScript = [System.IO.Path]::Combine($PSScriptRoot, "scripts", "install-register.mjs")
& $NodeExe "$RegisterScript" @args
$RegExitCode = $LASTEXITCODE
exit $(if ($null -ne $RegExitCode) { $RegExitCode } else { 0 })

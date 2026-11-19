# Agy-Context-Saver Universal Installer for Windows
# Installs plugin link, CLI shims, RTK >= 1.1.0, and configures node.cmd for hooks

$ErrorActionPreference = "Stop"

$ProfileRoot = if ($env:AGY_TEST_PROFILE_DIR) { $env:AGY_TEST_PROFILE_DIR } else { $env:USERPROFILE }
$GeminiConfigDir = [System.IO.Path]::Combine($ProfileRoot, ".gemini", "config")
$DestHook = [System.IO.Path]::Combine($GeminiConfigDir, "scripts", "execution-guard-hook.mjs")
$NodeCmdPath = [System.IO.Path]::Combine($GeminiConfigDir, "node.cmd")
$NodeCmdBakPath = [System.IO.Path]::Combine($GeminiConfigDir, "node.cmd.bak")

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

# 1. Run cross-platform registration engine FIRST (validates config & provisions RTK before any wrapper write)
$RegisterScript = [System.IO.Path]::Combine($PSScriptRoot, "scripts", "install-register.mjs")
& $NodeExe "$RegisterScript" @args
$RegExitCode = $LASTEXITCODE
if ($RegExitCode -ne 0) {
    exit $RegExitCode
}

$IsReadOnly = $args -contains "--check" -or $args -contains "-c" -or $args -contains "--status" -or $args -contains "status" -or $args -contains "--help" -or $args -contains "-h" -or $args -contains "help"
$IsUninstall = $args -contains "--uninstall" -or $args -contains "uninstall"
$IsRestoreOnly = ($args -contains "--restore-backups" -or $args -contains "restore-backups") -and (-not $IsUninstall)

if ($IsUninstall) {
    if (Test-Path $NodeCmdPath) {
        $ExistingContent = Get-Content -Path $NodeCmdPath -Raw -ErrorAction SilentlyContinue
        if ($ExistingContent -match "agy-context-saver-managed") {
            Remove-Item -Path $NodeCmdPath -Force -ErrorAction SilentlyContinue
            if (Test-Path $NodeCmdBakPath) {
                Move-Item -Path $NodeCmdBakPath -Destination $NodeCmdPath -Force
                Write-Host "[OK] Restored previous node.cmd from backup: $NodeCmdBakPath" -ForegroundColor Green
            } else {
                Write-Host "[OK] Removed managed node.cmd wrapper: $NodeCmdPath" -ForegroundColor Green
            }
        }
    }
    exit 0
}

if (-not $IsReadOnly -and -not $IsRestoreOnly) {
    # 2. Ensure ~/.gemini/config exists after preflight/registration succeeded
    if (-not (Test-Path $GeminiConfigDir)) {
        New-Item -ItemType Directory -Path $GeminiConfigDir -Force | Out-Null
    }

    # Preserve any pre-existing unmanaged node.cmd wrapper
    if (Test-Path $NodeCmdPath) {
        $ExistingWrapper = Get-Content -Path $NodeCmdPath -Raw -ErrorAction SilentlyContinue
        if ($ExistingWrapper -and ($ExistingWrapper -notmatch "agy-context-saver-managed") -and (-not (Test-Path $NodeCmdBakPath))) {
            Copy-Item -Path $NodeCmdPath -Destination $NodeCmdBakPath -Force
            Write-Host "[OK] Backed up existing node.cmd to: $NodeCmdBakPath" -ForegroundColor Green
        }
    }

    # 3. Create managed node.cmd wrapper in ~/.gemini/config (delegates non-governor calls to real node.exe)
    $NodeCmdLines = @(
        '@echo off',
        'chcp 65001 >nul',
        'REM agy-context-saver-managed',
        'if /i "%~nx1"=="execution-guard-hook.mjs" goto :hook',
        'if /i "%~nx1"=="execution-guard.mjs" goto :hook',
        "`"$NodeExe`" %*",
        'exit /b %errorlevel%',
        ':hook',
        "`"$NodeExe`" `"$DestHook`" %*",
        'exit /b %errorlevel%'
    )
    $NodeCmdContent = ($NodeCmdLines -join "`r`n") + "`r`n"
    [System.IO.File]::WriteAllText($NodeCmdPath, $NodeCmdContent, [System.Text.UTF8Encoding]::new($false))
    Write-Host "[OK] Node wrapper installed to: $NodeCmdPath" -ForegroundColor Green
}

exit 0

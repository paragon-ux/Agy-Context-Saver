# Agy-Context-Saver Universal Installer for Windows
# Installs hook script, wrapper, and registers in ~/.gemini/config/hooks.json & mcp_config.json

$ErrorActionPreference = "Stop"

$ProfileRoot = if ($env:AGY_TEST_PROFILE_DIR) { $env:AGY_TEST_PROFILE_DIR } else { $env:USERPROFILE }
$GeminiConfigDir = [System.IO.Path]::Combine($ProfileRoot, ".gemini", "config")
$DestHook = [System.IO.Path]::Combine($GeminiConfigDir, "scripts", "execution-guard-hook.mjs")
$NodeCmdPath = [System.IO.Path]::Combine($GeminiConfigDir, "node.cmd")
$NodeCmdBakPath = [System.IO.Path]::Combine($GeminiConfigDir, "node.cmd.bak")

# Dynamic Node executable resolution
$NodeCmdObj = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmdObj -and $NodeCmdObj.Source) {
    $NodeExe = $NodeCmdObj.Source
} elseif (Test-Path "C:\Program Files\nodejs\node.exe") {
    $NodeExe = "C:\Program Files\nodejs\node.exe"
} else {
    $NodeExe = "node"
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
                Copy-Item -Path $NodeCmdBakPath -Destination $NodeCmdPath -Force
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
        'REM agy-context-saver-managed',
        'setlocal',
        'set "ARGS=%*"',
        '',
        'echo %ARGS% | findstr /i "execution-guard" >nul',
        'if %errorlevel% equ 0 (',
        "    `"$NodeExe`" `"$DestHook`"",
        '    exit /b %errorlevel%',
        ')',
        '',
        "`"$NodeExe`" %*",
        'exit /b %errorlevel%'
    )
    $NodeCmdContent = $NodeCmdLines -join "`r`n"
    Set-Content -Path $NodeCmdPath -Value $NodeCmdContent -Encoding ASCII
    Write-Host "[OK] Node wrapper installed to: $NodeCmdPath" -ForegroundColor Green
}

exit 0

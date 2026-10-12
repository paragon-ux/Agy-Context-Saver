# Agy-Context-Saver Universal Installer for Windows
# Installs hook script, wrapper, and registers in ~/.gemini/config/hooks.json & mcp_config.json

$ErrorActionPreference = "Stop"

$GeminiConfigDir = [System.IO.Path]::Combine($env:USERPROFILE, ".gemini", "config")
$DestHook = [System.IO.Path]::Combine($GeminiConfigDir, "scripts", "execution-guard-hook.mjs")

# Dynamic Node executable resolution
$NodeCmdObj = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmdObj -and $NodeCmdObj.Source) {
    $NodeExe = $NodeCmdObj.Source
} elseif (Test-Path "C:\Program Files\nodejs\node.exe") {
    $NodeExe = "C:\Program Files\nodejs\node.exe"
} else {
    $NodeExe = "node"
}

# Check for read-only invocation flags
$IsReadOnly = $args -contains "--check" -or $args -contains "-c" -or $args -contains "--status" -or $args -contains "status" -or $args -contains "--help" -or $args -contains "-h" -or $args -contains "help"

if (-not $IsReadOnly) {
    # 1. Ensure ~/.gemini/config exists
    if (-not (Test-Path $GeminiConfigDir)) {
        New-Item -ItemType Directory -Path $GeminiConfigDir -Force | Out-Null
    }

    # 2. Create node.cmd wrapper in ~/.gemini/config (prevents Windows cmd quote issues)
    $NodeCmdPath = [System.IO.Path]::Combine($GeminiConfigDir, "node.cmd")
    $NodeCmdLines = @(
        '@echo off',
        'setlocal',
        'set "ARGS=%*"',
        '',
        'echo %ARGS% | findstr /i "execution-guard" >nul',
        'if %errorlevel% equ 0 (',
        "    `"$NodeExe`" `"$DestHook`"",
        '    exit /b %errorlevel%',
        ')',
        '',
        'echo {"decision": "allow"}',
        'exit /b 0'
    )
    $NodeCmdContent = $NodeCmdLines -join "`r`n"
    Set-Content -Path $NodeCmdPath -Value $NodeCmdContent -Encoding ASCII
    Write-Host "[OK] Node wrapper installed to: $NodeCmdPath" -ForegroundColor Green
}

# 3. Run cross-platform registration engine forwarding arguments
$RegisterScript = [System.IO.Path]::Combine($PSScriptRoot, "scripts", "install-register.mjs")
& $NodeExe "$RegisterScript" @args
exit $LASTEXITCODE

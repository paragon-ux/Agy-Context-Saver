# Agy-Context-Saver Universal Installer for Windows
# Installs hook script, wrapper, and registers in ~/.gemini/config/hooks.json & mcp_config.json

$ErrorActionPreference = "Stop"

$GeminiConfigDir = [System.IO.Path]::Combine($env:USERPROFILE, ".gemini", "config")
$DestHook = [System.IO.Path]::Combine($GeminiConfigDir, "scripts", "execution-guard-hook.mjs")

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
    "    `"C:\Program Files\nodejs\node.exe`" `"$DestHook`"",
    '    exit /b %errorlevel%',
    ')',
    '',
    'echo %ARGS% | findstr /i "waymark" >nul',
    'if %errorlevel% equ 0 (',
    '    "C:\Program Files\nodejs\node.exe" "%USERPROFILE%\Desktop\Frameworks\Deepseek-Project\Waymark\scripts\hooks\waymark-compact-hook.mjs"',
    '    exit /b %errorlevel%',
    ')',
    '',
    'echo {"decision": "allow"}',
    'exit /b 0'
)
$NodeCmdContent = $NodeCmdLines -join "`r`n"
Set-Content -Path $NodeCmdPath -Value $NodeCmdContent -Encoding ASCII
Write-Host "[OK] Node wrapper installed to: $NodeCmdPath" -ForegroundColor Green

# 3. Run cross-platform registration engine
$RegisterScript = [System.IO.Path]::Combine($PSScriptRoot, "scripts", "install-register.mjs")
& node "$RegisterScript"

# Agy-Context-Saver Universal Installer for Windows
# Installs hook script, wrapper, and registers in ~/.gemini/config/hooks.json

$ErrorActionPreference = "Stop"

$GeminiConfigDir = [System.IO.Path]::Combine($env:USERPROFILE, ".gemini", "config")
$ScriptsDir = [System.IO.Path]::Combine($GeminiConfigDir, "scripts")
$HooksJsonPath = [System.IO.Path]::Combine($GeminiConfigDir, "hooks.json")
$SourceHook = [System.IO.Path]::Combine($PSScriptRoot, "scripts", "execution-guard-hook.mjs")

Write-Host "Installing Agy-Context-Saver..." -ForegroundColor Cyan

# 1. Ensure scripts directory exists
if (-not (Test-Path $ScriptsDir)) {
    New-Item -ItemType Directory -Path $ScriptsDir -Force | Out-Null
}

# 2. Copy hook script
$DestHook = [System.IO.Path]::Combine($ScriptsDir, "execution-guard-hook.mjs")
Copy-Item -Path $SourceHook -Destination $DestHook -Force
Write-Host "✓ Hook script installed to $DestHook" -ForegroundColor Green

# 3. Create node.cmd wrapper in ~/.gemini/config (prevents Windows cmd quote issues)
$NodeCmdPath = [System.IO.Path]::Combine($GeminiConfigDir, "node.cmd")
$NodeCmdContent = @"
@echo off
setlocal
set "ARGS=%*"

echo %ARGS% | findstr /i "execution-guard" >nul
if %errorlevel% equ 0 (
    "C:\Program Files\nodejs\node.exe" "$DestHook"
    exit /b %errorlevel%
)

echo %ARGS% | findstr /i "waymark" >nul
if %errorlevel% equ 0 (
    "C:\Program Files\nodejs\node.exe" "%USERPROFILE%\Desktop\Frameworks\Deepseek-Project\Waymark\scripts\hooks\waymark-compact-hook.mjs"
    exit /b %errorlevel%
)

echo {"decision": "allow"}
exit /b 0
"@
Set-Content -Path $NodeCmdPath -Value $NodeCmdContent -Encoding ASCII
Write-Host "✓ Node wrapper installed to $NodeCmdPath" -ForegroundColor Green

# 4. Register in hooks.json
$HooksConfig = @{}
if (Test-Path $HooksJsonPath) {
    try {
        $HooksConfig = Get-Content -Path $HooksJsonPath -Raw | ConvertFrom-Json -AsHashtable
    } catch {
        $HooksConfig = @{}
    }
}

$HooksConfig["execution-guard"] = @{
    "PreToolUse" = @(
        @{
            "matcher" = "manage_task|run_command|schedule"
            "hooks" = @(
                @{
                    "type" = "command"
                    "command" = "node scripts/execution-guard-hook.mjs"
                    "timeout" = 5
                }
            )
        }
    )
}

$UpdatedJson = $HooksConfig | ConvertTo-Json -Depth 10
Set-Content -Path $HooksJsonPath -Value $UpdatedJson -Encoding UTF8
Write-Host "✓ Registered in $HooksJsonPath" -ForegroundColor Green

Write-Host "`nAgy-Context-Saver installation complete!" -ForegroundColor Cyan

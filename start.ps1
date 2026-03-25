#Requires -Version 5.1
<#
  Kady — Windows startup (same flow as start.sh)
  Run from repo root:  .\start.ps1
  Or double-click:     start.bat
#>
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Write-Banner([string]$Text) {
    Write-Host ''
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host ''
}

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-UvIfMissing {
    if (Test-Command 'uv') {
        Write-Host '  uv ✓' -ForegroundColor Green
        return
    }
    Write-Host '  uv not found — installing (Python package manager)...' -ForegroundColor Yellow
    powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://astral.sh/uv/install.ps1 | iex"
    Refresh-Path
    if (-not (Test-Command 'uv')) {
        Write-Host '  uv still not on PATH. Close this window, reopen PowerShell, and run again.' -ForegroundColor Red
        exit 1
    }
}

function Install-NodeHint {
    if (Test-Command 'node') {
        Write-Host '  Node.js ✓' -ForegroundColor Green
        return
    }
    Write-Host '  Node.js not found.' -ForegroundColor Yellow
    Write-Host '  Install LTS from https://nodejs.org/ or run: winget install OpenJS.NodeJS.LTS' -ForegroundColor Yellow
    exit 1
}

function Install-GeminiCliIfMissing {
    if (Test-Command 'gemini') {
        Write-Host '  Gemini CLI ✓' -ForegroundColor Green
        return
    }
    Write-Host '  Gemini CLI not found — installing (used to run expert tasks)...' -ForegroundColor Yellow
    npm install -g @google/gemini-cli
}

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-Host "  Missing file: $Path" -ForegroundColor Red
        exit 1
    }
    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { return }
        $name = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Stop-ProcessTree([int]$ProcessId) {
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

Write-Banner 'Kady — Starting up'

Write-Host 'Checking dependencies...' -ForegroundColor White
Install-UvIfMissing
Install-NodeHint
Install-GeminiCliIfMissing
Write-Host ''

Write-Host 'Installing Python packages...' -ForegroundColor White
& uv sync --quiet

Write-Host 'Installing frontend packages...' -ForegroundColor White
Push-Location (Join-Path $PSScriptRoot 'web')
try {
    & npm install --silent
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Loading environment from kady_agent\.env...' -ForegroundColor White
Import-DotEnv (Join-Path $PSScriptRoot 'kady_agent\.env')

Write-Host 'Preparing sandbox (creates sandbox\ dir, downloads scientific skills from K-Dense)...' -ForegroundColor White
& uv run python prep_sandbox.py

Write-Host ''
Write-Host 'Starting services...' -ForegroundColor White
Write-Host ''

$root = $PSScriptRoot
$webDir = Join-Path $root 'web'

$uvExe = (Get-Command uv -ErrorAction Stop).Source
$npmExe = (Get-Command npm -ErrorAction Stop).Source

# Each service runs in its own console so logs are readable on Windows (unlike one mixed shell).
Write-Host '  → LiteLLM proxy on port 4000 (routes LLM calls to OpenRouter)' -ForegroundColor Gray
$pLite = Start-Process -FilePath $uvExe -ArgumentList @(
    'run', 'litellm', '--config', 'litellm_config.yaml', '--port', '4000'
) -WorkingDirectory $root -PassThru

Start-Sleep -Seconds 2

Write-Host '  → Backend on port 8000 (FastAPI + ADK agent)' -ForegroundColor Gray
$pBack = Start-Process -FilePath $uvExe -ArgumentList @(
    'run', 'uvicorn', 'server:app', '--reload', '--port', '8000'
) -WorkingDirectory $root -PassThru

Write-Host '  → Frontend on port 3000 (Next.js UI)' -ForegroundColor Gray
$pFront = Start-Process -FilePath $npmExe -ArgumentList @('run', 'dev') -WorkingDirectory $webDir -PassThru

Write-Host ''
Write-Banner 'All services running!'
Write-Host '  UI: http://localhost:3000' -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop everything" -ForegroundColor Yellow
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''

Start-Job -ScriptBlock {
    Start-Sleep -Seconds 3
    Start-Process "http://localhost:3000" -ErrorAction SilentlyContinue
} | Out-Null

try {
    while ($true) {
        Start-Sleep -Seconds 2
        if ($pLite.HasExited -and $pBack.HasExited -and $pFront.HasExited) { break }
    }
} finally {
    Write-Host ''
    Write-Host "Stopping services..." -ForegroundColor Yellow
    foreach ($p in @($pLite, $pBack, $pFront)) {
        if ($null -ne $p -and -not $p.HasExited) {
            Stop-ProcessTree $p.Id
        }
    }
    Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
}

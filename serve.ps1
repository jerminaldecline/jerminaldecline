# Local development server for jerminaldecline.com
#
# Usage:
#   .\serve.ps1
#   .\serve.ps1 -Port 8080
#
# Then open http://localhost:8000 (or whatever port) in your browser.
# Edit any file in public/, refresh the browser, see your changes immediately.
# Press Ctrl+C to stop the server.

param(
    [int]$Port = 8000
)

$publicDir = Join-Path $PSScriptRoot "public"

if (-not (Test-Path $publicDir)) {
    Write-Host "ERROR: Can't find public/ directory at $publicDir" -ForegroundColor Red
    Write-Host "Run this script from the repo root." -ForegroundColor Yellow
    exit 1
}

# Try Python first (preferred — usually pre-installed on Windows)
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command python3 -ErrorAction SilentlyContinue
}

if ($python) {
    Write-Host "Starting local server at http://localhost:$Port" -ForegroundColor Cyan
    Write-Host "Serving: $publicDir" -ForegroundColor DarkGray
    Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
    Write-Host ""
    Set-Location $publicDir
    & $python.Source -m http.server $Port
    exit
}

# Fallback: try Node.js with npx
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Write-Host "Python not found, using Node.js (npx serve)..." -ForegroundColor Yellow
    Write-Host "Starting local server at http://localhost:$Port" -ForegroundColor Cyan
    Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
    Write-Host ""
    Set-Location $publicDir
    npx serve --listen $Port .
    exit
}

Write-Host "ERROR: Neither Python nor Node.js found on PATH." -ForegroundColor Red
Write-Host ""
Write-Host "Install Python (recommended): https://www.python.org/downloads/" -ForegroundColor Yellow
Write-Host "Or install Node.js: https://nodejs.org/" -ForegroundColor Yellow
exit 1

#!/usr/bin/env pwsh
# install-windows.ps1 — wire qmemd into Claude Code on native Windows.
# Idempotent. PowerShell 5.1-compatible.
[CmdletBinding()]
param(
    [switch] $NoDisableMemory,
    [switch] $WriteBeacon,
    [switch] $Help
)

if ($Help) {
    Write-Host 'Usage: install-windows.ps1 [-NoDisableMemory] [-WriteBeacon] [-Help]'
    Write-Host '  -NoDisableMemory   Leave Claude built-in auto-memory as-is (default: set autoMemoryEnabled=false).'
    Write-Host '  -WriteBeacon       Also wire the experimental Stop write-beacon hook (needs QMEMD_WRITE_BEACON=1 at runtime).'
    exit 0
}

$ErrorActionPreference = 'Stop'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$configDir = $env:CLAUDE_CONFIG_DIR
if ([string]::IsNullOrEmpty($configDir)) { $configDir = Join-Path $env:USERPROFILE '.claude' }
Import-Module (Join-Path $PSScriptRoot (Join-Path 'lib' 'QmemdInstall.psm1')) -Force

# --- Phase 0: prerequisites (check + guide) ---
Write-Host '== Phase 0: prerequisites =='
$hasBun = [bool](Get-Command bun -ErrorAction SilentlyContinue)
$hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)
$missing = Get-MissingPrerequisites -HasBun $hasBun -HasGit $hasGit
if (@($missing).Count -gt 0) {
    Write-Host 'Missing prerequisites:'
    foreach ($m in $missing) { Write-Host "  - $m" }
    exit 1
}

# --- Phase 1: build (@tobilu/qmd resolves from the npm registry) ---
Write-Host '== Phase 1: build =='
Push-Location $RepoRoot
try {
    & bun install
    if ($LASTEXITCODE -ne 0) { Write-Host 'bun install failed.'; exit 1 }
    & bun run build
    if ($LASTEXITCODE -ne 0) { Write-Host 'bun run build failed.'; exit 1 }
} finally {
    Pop-Location
}

# --- Phase 2: PATH ---
Write-Host '== Phase 2: PATH =='
$binDir   = Join-Path $RepoRoot 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$newPath  = Get-UpdatedUserPath -CurrentPath $userPath -Entry $binDir
if ($newPath -ne $userPath) {
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "  Added $binDir to your User PATH. Open a NEW shell to pick it up."
} else {
    Write-Host "  $binDir already on User PATH."
}

# --- Phase 3: Claude wiring ---
Write-Host '== Phase 3: Claude Code integration =='
Install-ClaudeIntegration -ConfigDir $configDir -RepoRoot $RepoRoot -DisableMemory (-not $NoDisableMemory) -WriteBeacon:$WriteBeacon
Write-Host "  settings.json + CLAUDE.md wired (config dir: $configDir)"
if ($NoDisableMemory) { Write-Host '  autoMemoryEnabled: left unchanged (-NoDisableMemory)' }
else { Write-Host '  autoMemoryEnabled: set to false' }

Write-Host ''
Write-Host 'Last step — register the MCP server (pick a scope; this script will not run it):'
Write-Host '    claude mcp add qmemd -- qmemd mcp'

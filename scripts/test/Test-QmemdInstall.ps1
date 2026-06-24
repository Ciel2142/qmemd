#!/usr/bin/env pwsh
# Dependency-free assertion tests for QmemdInstall.psm1 (PowerShell 5.1+ / pwsh 7).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Cross-platform module path: backslash literals do NOT resolve under pwsh on Linux.
$modulePath = Join-Path (Split-Path -Parent $here) (Join-Path 'lib' 'QmemdInstall.psm1')
Import-Module $modulePath -Force

$script:fail = 0
function Assert([bool]$cond, [string]$msg) {
    if ($cond) { Write-Host "  PASS: $msg" }
    else { Write-Host "  FAIL: $msg"; $script:fail++ }
}
function New-TempDir {
    $d = Join-Path ([IO.Path]::GetTempPath()) ("qmemd-test-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $d | Out-Null
    return $d
}

Write-Host 'Test: fresh config dir'
$cfg = New-TempDir; $repo = New-TempDir
Install-ClaudeIntegration -ConfigDir $cfg -RepoRoot $repo -DisableMemory $true
$s = Get-Content -Raw (Join-Path $cfg 'settings.json') | ConvertFrom-Json
Assert ($s.autoMemoryEnabled -eq $false) 'autoMemoryEnabled = false'
Assert ((Get-HookCommands -Settings $s -Event 'SessionStart') -contains 'qmemd recall --session') 'SessionStart hook present'
Assert ((Get-HookCommands -Settings $s -Event 'PreToolUse') -contains 'qmemd hook beacon') 'PreToolUse beacon present'
Assert (((Get-Content -Raw (Join-Path $cfg 'CLAUDE.md')) -match 'qmemd\.md') ) 'CLAUDE.md @import appended'

Write-Host 'Test: -WriteBeacon adds the Stop hook (opt-in)'
$cfgW = New-TempDir; $repoW = New-TempDir
Install-ClaudeIntegration -ConfigDir $cfgW -RepoRoot $repoW -DisableMemory $true -WriteBeacon $true
$sw = Get-Content -Raw (Join-Path $cfgW 'settings.json') | ConvertFrom-Json
Assert ((Get-HookCommands -Settings $sw -Event 'Stop') -contains 'qmemd hook write-beacon') 'Stop write-beacon present with -WriteBeacon'

Write-Host 'Test: default run wires no Stop hook'
$cfgN = New-TempDir; $repoN = New-TempDir
Install-ClaudeIntegration -ConfigDir $cfgN -RepoRoot $repoN -DisableMemory $true
$sn = Get-Content -Raw (Join-Path $cfgN 'settings.json') | ConvertFrom-Json
Assert (-not ((Get-HookCommands -Settings $sn -Event 'Stop') -contains 'qmemd hook write-beacon')) 'no Stop hook by default'

Write-Host 'Test: idempotent re-run'
Install-ClaudeIntegration -ConfigDir $cfg -RepoRoot $repo -DisableMemory $true
$s2 = Get-Content -Raw (Join-Path $cfg 'settings.json') | ConvertFrom-Json
Assert ((@(Get-HookCommands -Settings $s2 -Event 'SessionStart' | Where-Object { $_ -eq 'qmemd recall --session' }).Count) -eq 1) 'SessionStart not duplicated'
Assert ((@(Get-HookCommands -Settings $s2 -Event 'PreToolUse' | Where-Object { $_ -eq 'qmemd hook beacon' }).Count) -eq 1) 'beacon not duplicated'
Assert ((@(Get-Content (Join-Path $cfg 'CLAUDE.md') | Where-Object { $_ -match 'qmemd\.md' }).Count) -eq 1) 'import line not duplicated'

Write-Host 'Test: preserves unrelated keys + hooks'
$cfg3 = New-TempDir; $repo3 = New-TempDir
$seed = [pscustomobject]@{
    theme = 'dark'
    hooks = [pscustomobject]@{
        PostToolUse = @([pscustomobject]@{ matcher = 'Edit'; hooks = @([pscustomobject]@{ type = 'command'; command = 'prettier' }) })
    }
}
[IO.File]::WriteAllText((Join-Path $cfg3 'settings.json'), ($seed | ConvertTo-Json -Depth 100))
Install-ClaudeIntegration -ConfigDir $cfg3 -RepoRoot $repo3 -DisableMemory $true
$s3 = Get-Content -Raw (Join-Path $cfg3 'settings.json') | ConvertFrom-Json
Assert ($s3.theme -eq 'dark') 'unrelated key theme preserved'
Assert ((Get-HookCommands -Settings $s3 -Event 'PostToolUse') -contains 'prettier') 'unrelated PostToolUse hook preserved'
Assert ((Get-HookCommands -Settings $s3 -Event 'SessionStart') -contains 'qmemd recall --session') 'new SessionStart added alongside'

Write-Host 'Test: -DisableMemory $false; no UTF-8 BOM'
$cfg4 = New-TempDir; $repo4 = New-TempDir
Install-ClaudeIntegration -ConfigDir $cfg4 -RepoRoot $repo4 -DisableMemory $false
$s4 = Get-Content -Raw (Join-Path $cfg4 'settings.json') | ConvertFrom-Json
Assert (-not (Get-Member -InputObject $s4 -Name 'autoMemoryEnabled' -MemberType Properties)) 'autoMemoryEnabled unset when DisableMemory=false'
$bytes = [IO.File]::ReadAllBytes((Join-Path $cfg4 'settings.json'))
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
Assert (-not $hasBom) 'settings.json written without UTF-8 BOM'

Write-Host 'Test: cross-installer SessionStart not double-wired'
$cfg5 = New-TempDir; $repo5 = New-TempDir
$linuxCmd = 'qmemd recall --session --project "$(basename "$PWD")"'
$seed5 = [pscustomobject]@{
    hooks = [pscustomobject]@{
        SessionStart = @([pscustomobject]@{ matcher = '*'; hooks = @([pscustomobject]@{ type = 'command'; command = $linuxCmd }) })
    }
}
[IO.File]::WriteAllText((Join-Path $cfg5 'settings.json'), ($seed5 | ConvertTo-Json -Depth 100))
Install-ClaudeIntegration -ConfigDir $cfg5 -RepoRoot $repo5 -DisableMemory $true
$s5 = Get-Content -Raw (Join-Path $cfg5 'settings.json') | ConvertFrom-Json
$ss5 = @(Get-HookCommands -Settings $s5 -Event 'SessionStart')
Assert ($ss5.Count -eq 1) 'existing Linux SessionStart not duplicated by bare form'
Assert ($ss5[0] -eq $linuxCmd) 'existing Linux SessionStart preserved as-is'
Assert ((Get-HookCommands -Settings $s5 -Event 'PreToolUse') -contains 'qmemd hook beacon') 'beacon still wired alongside existing SessionStart'

Write-Host 'Test: Get-UpdatedUserPath'
$entry = 'C:\repo\bin'
Assert ((Get-UpdatedUserPath -CurrentPath '' -Entry $entry) -eq $entry) 'empty PATH -> entry'
Assert ((Get-UpdatedUserPath -CurrentPath 'C:\a;C:\b' -Entry $entry) -eq "C:\a;C:\b;$entry") 'missing (multi) -> appended'
Assert ((Get-UpdatedUserPath -CurrentPath "C:\a;$entry;C:\b" -Entry $entry) -eq "C:\a;$entry;C:\b") 'present -> unchanged'
Assert ((Get-UpdatedUserPath -CurrentPath "C:\a;$entry\" -Entry $entry) -eq "C:\a;$entry\") 'present (trailing slash) -> unchanged'
# Regression (code-review Critical): a single surviving element must still join with ';'.
Assert ((Get-UpdatedUserPath -CurrentPath 'C:\a' -Entry $entry) -eq "C:\a;$entry") 'single element -> appended with separator'
Assert ((Get-UpdatedUserPath -CurrentPath 'C:\a;' -Entry $entry) -eq "C:\a;$entry") 'trailing semicolon -> appended with separator'

Write-Host 'Test: Get-MissingPrerequisites'
Assert ((@(Get-MissingPrerequisites -HasBun $true -HasGit $true)).Count -eq 0) 'all present -> empty'
# @(...) on assignment: a 1-element return unwraps to a scalar string, and indexing
# [0] on a string yields its first CHARACTER, not the message. Force array context.
$mBun = @(Get-MissingPrerequisites -HasBun $false -HasGit $true)
Assert (($mBun.Count -eq 1) -and ($mBun[0] -match 'Oven-sh\.Bun')) 'bun missing -> winget Bun hint'
$mGit = @(Get-MissingPrerequisites -HasBun $true -HasGit $false)
Assert (($mGit.Count -eq 1) -and ($mGit[0] -match 'Git\.Git')) 'git missing -> winget Git hint'
Assert ((@(Get-MissingPrerequisites -HasBun $false -HasGit $false)).Count -eq 2) 'both missing -> two messages'

Write-Host ''
if ($script:fail -gt 0) { Write-Host "$script:fail assertion(s) FAILED"; exit 1 }
Write-Host 'All assertions passed'; exit 0

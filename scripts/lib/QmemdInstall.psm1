# QmemdInstall.psm1 — testable installer functions (PowerShell 5.1-compatible).

function Set-JsonProperty {
    param([Parameter(Mandatory)] $Object, [Parameter(Mandatory)] [string] $Name, $Value)
    if (Get-Member -InputObject $Object -Name $Name -MemberType Properties) {
        $Object.$Name = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
    return $Object
}

function Get-HookCommands {
    param([Parameter(Mandatory)] $Settings, [Parameter(Mandatory)] [string] $Event)
    $out = @()
    if (-not (Get-Member -InputObject $Settings -Name 'hooks' -MemberType Properties)) { return $out }
    $hooks = $Settings.hooks
    if (-not (Get-Member -InputObject $hooks -Name $Event -MemberType Properties)) { return $out }
    foreach ($group in @($hooks.$Event)) {
        if ($null -ne $group -and (Get-Member -InputObject $group -Name 'hooks' -MemberType Properties)) {
            foreach ($h in @($group.hooks)) { if ($h.command) { $out += $h.command } }
        }
    }
    return $out
}

function Add-HookCommand {
    param([Parameter(Mandatory)] $Settings, [Parameter(Mandatory)] [string] $Event,
          [Parameter(Mandatory)] [string] $Matcher, [Parameter(Mandatory)] [string] $Command,
          [string] $EquivalentPattern)
    if (-not (Get-Member -InputObject $Settings -Name 'hooks' -MemberType Properties)) {
        $Settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([pscustomobject]@{})
    }
    $hooks = $Settings.hooks
    if (-not (Get-Member -InputObject $hooks -Name $Event -MemberType Properties)) {
        $hooks | Add-Member -NotePropertyName $Event -NotePropertyValue @()
    }
    $existing = Get-HookCommands -Settings $Settings -Event $Event
    if ($existing -contains $Command) { return $Settings }
    # Treat a cross-installer equivalent (e.g. the Linux installer's
    # 'qmemd recall --session --project "..."') as already-present, so a shared
    # config dir never gets the same hook double-wired.
    if ($EquivalentPattern -and (@($existing | Where-Object { $_ -match $EquivalentPattern }).Count -gt 0)) { return $Settings }
    $newGroup = [pscustomobject]@{
        matcher = $Matcher
        hooks   = @([pscustomobject]@{ type = 'command'; command = $Command })
    }
    $hooks.$Event = @($hooks.$Event) + $newGroup
    return $Settings
}

function Install-ClaudeIntegration {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $ConfigDir, [Parameter(Mandatory)] [string] $RepoRoot,
          [bool] $DisableMemory = $true, [bool] $WriteBeacon = $false)

    $settingsPath    = Join-Path $ConfigDir 'settings.json'
    $claudeMdPath    = Join-Path $ConfigDir 'CLAUDE.md'
    $ruleFile        = Join-Path $RepoRoot (Join-Path 'claude' 'qmemd.md')
    $importLine      = "@$ruleFile"
    $sessionCmd      = 'qmemd recall --session'
    $beaconCmd       = 'qmemd hook beacon'
    $writeBeaconCmd  = 'qmemd hook write-beacon'

    if (-not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null }

    if (Test-Path $settingsPath) {
        $raw = Get-Content -Raw -Path $settingsPath
        if ([string]::IsNullOrWhiteSpace($raw)) { $settings = [pscustomobject]@{} }
        else { $settings = $raw | ConvertFrom-Json }
    } else {
        $settings = [pscustomobject]@{}
    }

    if ($DisableMemory) { $settings = Set-JsonProperty -Object $settings -Name 'autoMemoryEnabled' -Value $false }
    $settings = Add-HookCommand -Settings $settings -Event 'SessionStart' -Matcher '*'    -Command $sessionCmd -EquivalentPattern '^qmemd recall --session(\s|$)'
    $settings = Add-HookCommand -Settings $settings -Event 'PreToolUse'   -Matcher 'Bash' -Command $beaconCmd
    if ($WriteBeacon) {
        $settings = Add-HookCommand -Settings $settings -Event 'Stop' -Matcher '*' -Command $writeBeaconCmd
    }

    # UTF-8 NO BOM — Node's JSON.parse rejects a leading BOM.
    [System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 100))

    # CLAUDE.md @import (idempotent, ensure a separating newline).
    $present = $false
    if (Test-Path $claudeMdPath) {
        if ((Get-Content -Path $claudeMdPath) -contains $importLine) { $present = $true }
    }
    if (-not $present) {
        $prefix = ''
        if ((Test-Path $claudeMdPath) -and (Get-Item $claudeMdPath).Length -gt 0) {
            $existing = [System.IO.File]::ReadAllText($claudeMdPath)
            if (-not $existing.EndsWith("`n")) { $prefix = "`n" }
        }
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($claudeMdPath, ($prefix + $importLine + "`n"), $utf8NoBom)
    }
}

function Get-UpdatedUserPath {
    param([string] $CurrentPath, [Parameter(Mandatory)] [string] $Entry)
    $parts = @()
    if (-not [string]::IsNullOrEmpty($CurrentPath)) {
        # @(...) forces array context: a single surviving element would otherwise
        # collapse to a scalar string, turning the `$parts + $Entry` append on the
        # return line into string concatenation that drops the ';' separator.
        $parts = @($CurrentPath.Split(';') | Where-Object { $_ -ne '' })
    }
    foreach ($p in $parts) {
        if ($p.TrimEnd('\') -ieq $Entry.TrimEnd('\')) { return $CurrentPath }
    }
    return (@($parts + $Entry) -join ';')
}

function Get-MissingPrerequisites {
    param([bool] $HasBun, [bool] $HasGit)
    $missing = @()
    if (-not $HasBun) { $missing += 'Bun for Windows is required. Install: winget install Oven-sh.Bun  (then reopen the shell)' }
    if (-not $HasGit) { $missing += 'git is required. Install: winget install Git.Git' }
    return $missing
}

Export-ModuleMember -Function Install-ClaudeIntegration, Get-HookCommands, Get-UpdatedUserPath, Get-MissingPrerequisites

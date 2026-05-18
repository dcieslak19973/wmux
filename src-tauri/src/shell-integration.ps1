# wmux shell integration for PowerShell
# Source: https://github.com/dcieslak19973/wmux
#
# Emits OSC 133 sequences so wmux can demarcate command blocks.
# Only activates when running inside wmux (WMUX=1).

if ($env:WMUX -ne "1") { return }

$global:__wmux_first_prompt = $true

function prompt {
    if (-not $global:__wmux_first_prompt) {
        $code = $LASTEXITCODE ?? 0
        [Console]::Write("`e]133;D;${code}`a")
    }
    $global:__wmux_first_prompt = $false
    [Console]::Write("`e]133;A`a")

    # Default prompt — preserved if user has already customised theirs via $PROFILE
    # (this file should be sourced AFTER $PROFILE).
    "PS $($PWD.Path)$('>' * ($nestedPromptLevel + 1)) "

    [Console]::Write("`e]133;B`a")
}

Set-PSReadLineKeyHandler -Key Enter -BriefDescription "WmuxBlockEnter" -ScriptBlock {
    $line = $null; $cursor = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    if (-not [string]::IsNullOrWhiteSpace($line)) {
        [Console]::Write("`e]133;P=k=${line}`a")
    }
    [Console]::Write("`e]133;C`a")
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
}

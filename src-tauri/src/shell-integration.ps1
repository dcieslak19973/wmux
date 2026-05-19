# wmux shell integration for PowerShell
# Source: https://github.com/dcieslak19973/wmux
#
# Emits OSC 133 sequences so wmux can demarcate command blocks.
# Only activates when running inside wmux (WMUX=1).

if ($env:WMUX -ne "1") { return }

$global:__wmux_first_prompt = $true

function prompt {
    $esc = [char]27
    if (-not $global:__wmux_first_prompt) {
        $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
        [Console]::Write("${esc}]133;D;${code}`a")
    }
    $global:__wmux_first_prompt = $false
    [Console]::Write("${esc}]133;A`a")

    # Default prompt — preserved if user has already customised theirs via $PROFILE
    # (this file should be sourced AFTER $PROFILE).
    "PS $($PWD.Path)$('>' * ($nestedPromptLevel + 1)) "

    [Console]::Write("${esc}]133;B`a")
}

Set-PSReadLineKeyHandler -Key Enter -BriefDescription "WmuxBlockEnter" -ScriptBlock {
    $line = $null; $cursor = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    $esc = [char]27
    if (-not [string]::IsNullOrWhiteSpace($line)) {
        [Console]::Write("${esc}]133;P=k=${line}`a")
    }
    [Console]::Write("${esc}]133;C`a")
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
}

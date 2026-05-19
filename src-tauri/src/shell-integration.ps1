# wmux shell integration for PowerShell
# Source: https://github.com/dcieslak19973/wmux
#
# Emits OSC 133 sequences so wmux can demarcate command blocks.
# Only activates when running inside wmux (WMUX=1).

if ($env:WMUX -ne "1") { return }

$global:__wmux_first_prompt = $true
# Baseline error count — grows when PS cmdlets write non-terminating errors.
$global:__wmux_pre_error_count = $global:Error.Count

function prompt {
    # $? is reset by PSReadLine internals before prompt is called in PS5.1;
    # track $Error array growth instead — reliable for both cmdlets and native exes.
    $__wmux_code = $LASTEXITCODE
    $__wmux_had_error = ($global:Error.Count -gt $global:__wmux_pre_error_count)
    $esc = [char]27
    if (-not $global:__wmux_first_prompt) {
        $code = if ($__wmux_code) { $__wmux_code } elseif ($__wmux_had_error) { 1 } else { 0 }
        [Console]::Write("${esc}]133;D;${code}`a")
    }
    $global:__wmux_first_prompt = $false
    # Reset baseline so the next command starts clean.
    $global:__wmux_pre_error_count = $global:Error.Count
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
    # Snapshot error count just before AcceptLine so prompt() can detect
    # any new errors the command wrote.
    $global:__wmux_pre_error_count = $global:Error.Count
    if (-not [string]::IsNullOrWhiteSpace($line)) {
        [Console]::Write("${esc}]133;P=k=${line}`a")
    }
    [Console]::Write("${esc}]133;C`a")
    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
}

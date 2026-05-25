# wmux shell integration for zsh
# Source: https://github.com/dcieslak19973/wmux
#
# Emits OSC 133 sequences so wmux can demarcate command blocks.
# Only activates when running inside wmux (WMUX=1).

[ "${WMUX:-}" = "1" ] || return 0

__wmux_first_prompt=1

# Capture the previous command's exit code, emit prompt-start, and
# announce cwd via OSC 7. zsh runs precmd_functions right before each
# prompt, so $? is the last user command's exit code at this point.
__wmux_precmd() {
    local code=$?
    if [ -z "${__wmux_first_prompt:-}" ]; then
        printf '\033]133;D;%d\007' "$code"
    fi
    unset __wmux_first_prompt
    printf '\033]133;A\007'
    printf '\033]7;file://localhost%s\007' "${PWD// /%20}"
}

# Emit C right before the user command runs (zsh's preexec hook).
# Also emit the command line (for the block-store accumulator), using
# the OSC 133 ; L extension that the bash integration emits via PS0.
__wmux_preexec() {
    printf '\033]133;C\007'
    if [ -n "$1" ]; then
        printf '\033]133;L;%s\007' "$1"
    fi
}

# Register hooks; guard against duplicate registration if the file is
# sourced twice in one shell session.
typeset -ag precmd_functions preexec_functions
(( ${precmd_functions[(I)__wmux_precmd]} )) || precmd_functions+=(__wmux_precmd)
(( ${preexec_functions[(I)__wmux_preexec]} )) || preexec_functions+=(__wmux_preexec)

# B marker: end of prompt text, beginning of user input.
PS1="${PS1}"$'\033]133;B\007'

# A unique marker line so wmux can detect stale installs and prompt the
# user to re-run the install command. Keep this distinct from the bash
# script's unique marker.
# B marker: end of prompt text, beginning of user input (zsh)

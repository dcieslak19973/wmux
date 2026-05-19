# wmux shell integration for bash
# Source: https://github.com/dcieslak19973/wmux
#
# Emits OSC 133 sequences so wmux can demarcate command blocks.
# Only activates when running inside wmux (WMUX=1).

[ "${WMUX:-}" = "1" ] || return 0

__wmux_first_prompt=1
__wmux_last_code=0

# Runs first in PROMPT_COMMAND to capture $? before any other entry resets it.
__wmux_save_code() { __wmux_last_code=$?; }

__wmux_precmd() {
    local code=$__wmux_last_code
    __wmux_last_code=0
    if [ -z "${__wmux_first_prompt:-}" ]; then
        printf '\033]133;D;%d\007' "$code"
    fi
    unset __wmux_first_prompt
    printf '\033]133;A\007'
}

# __wmux_save_code must be first so it captures the user command's $?.
# __wmux_precmd must be last so D fires after all other prompt output.
PROMPT_COMMAND="__wmux_save_code${PROMPT_COMMAND:+;${PROMPT_COMMAND}};__wmux_precmd"

# B marker: end of prompt text, beginning of user input
PS1="${PS1}"$'\033]133;B\007'

# C marker: emitted after Enter, before command runs (bash 4.4+)
PS0=$'\033]133;C\007'

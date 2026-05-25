# wmux shell integration for fish
# Source: https://github.com/dcieslak19973/wmux
#
# Emits OSC 133 sequences so wmux can demarcate command blocks.
# Only activates when running inside wmux (WMUX=1).

test "$WMUX" = "1"; or exit 0

set -g __wmux_first_prompt 1

# Wrap the user's existing fish_prompt to append the B marker (end of
# prompt text). Copy the original out of the way the first time we run,
# then redefine fish_prompt to call it and emit B.
if not functions -q __wmux_orig_fish_prompt
    functions --copy fish_prompt __wmux_orig_fish_prompt
end

function fish_prompt
    __wmux_orig_fish_prompt
    printf '\033]133;B\007'
end

# fish_prompt event fires just before fish renders the prompt — perfect
# spot for the A marker and OSC 7 cwd announcement.
function __wmux_pre_prompt --on-event fish_prompt
    if set -q __wmux_first_prompt
        set -e __wmux_first_prompt
    end
    printf '\033]133;A\007'
    printf '\033]7;file://localhost%s\007' (string replace -a ' ' '%20' "$PWD")
end

# C marker + command-line broadcast right before the command runs.
function __wmux_preexec --on-event fish_preexec
    printf '\033]133;C\007'
    if test -n "$argv"
        printf '\033]133;L;%s\007' "$argv"
    end
end

# D marker carries the exit code after the command finishes. Use the
# fish_postexec event (not fish_prompt) so the D is emitted as soon as
# the command returns, before the next prompt cycle.
function __wmux_postexec --on-event fish_postexec
    printf '\033]133;D;%s\007' $status
end

# B marker: end of prompt text, beginning of user input (fish)

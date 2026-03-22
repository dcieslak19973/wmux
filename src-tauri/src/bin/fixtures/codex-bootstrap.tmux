# Representative sourced config with continuations and inline comments.
set-option -g terminal-overrides '\
  ,*:Tc' # truecolor hint
set-window-option -g pane-border-format '#{pane_title}' ; refresh-client
display-message 'codex bootstrap ready'

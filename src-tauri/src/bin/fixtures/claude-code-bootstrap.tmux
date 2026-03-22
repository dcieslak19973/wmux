# Representative agent bootstrap focused on workspace setup.
set-option -g status off
set-option -g status-left '#S'
set-window-option -g synchronize-panes off

# Wait for the coordinator, then mark readiness.
wait-for bootstrap-ready
display-message -p -F '#{session_name}:#{window_id}' ; wait-for -S bootstrap-finished

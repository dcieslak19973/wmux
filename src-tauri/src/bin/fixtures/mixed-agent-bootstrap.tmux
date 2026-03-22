# Multiple wrappers often batch commands on one line.
set-option -g status-right 'agent:#(whoami)' ; set-window-option -g automatic-rename off
wait-for -L agent-lock
display-message 'workspace ready; attach if needed'
wait-for -U agent-lock ; wait-for -S agent-ready

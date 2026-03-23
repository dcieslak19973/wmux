export function createNewTabPopoverRuntime({
  document,
  invoke,
  createTab,
  getDefaultTarget,
  setDefaultTarget,
  loadSavedSshTargets,
  saveSavedSshTargets,
  buildConnectionTargetFromFields,
  normalizeSshTarget,
  REMOTE_TMUX_SESSION_MODES,
  sshTargetDisplayName,
  sshTargetDetailLabel,
  sshTargetsEqual,
  escHtml,
  showError,
  openRemoteTmuxWorkspaceFromProfile,
  getAnchorElement,
}) {
  async function showNewTabPopover() {
    document.getElementById('new-tab-popover')?.remove();

    let defaultTarget = getDefaultTarget();
    let savedSshTargets = loadSavedSshTargets();
    let editingSavedSshId = null;

    const isDefaultTarget = (target) => {
      if (target.type !== defaultTarget.type) return false;
      if (target.type === 'local') return true;
      if (target.type === 'wsl') return target.distro === defaultTarget.distro;
      if (target.type === 'ssh' || target.type === 'remote_tmux') return sshTargetsEqual(target, defaultTarget);
      return false;
    };

    const makeStarBtn = (target, closePopover) => {
      const isDefault = isDefaultTarget(target);
      const btn = document.createElement('button');
      btn.className = 'nt-set-default' + (isDefault ? ' is-default' : '');
      btn.title = isDefault ? 'Current default' : 'Set as default';
      btn.textContent = isDefault ? '★' : '☆';
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        setDefaultTarget(target);
        defaultTarget = target;
        closePopover();
      });
      return btn;
    };

    const makeItemRow = (target, itemBtn, closePopover) => {
      const row = document.createElement('div');
      row.className = 'nt-item-row';
      row.appendChild(itemBtn);
      row.appendChild(makeStarBtn(target, closePopover));
      return row;
    };

    const popover = document.createElement('div');
    popover.id = 'new-tab-popover';
    popover.className = 'nt-popover';
    popover.innerHTML = `
      <div class="nt-section-label">Shell</div>
      <div id="nt-local-row"></div>

      <div class="nt-section-label">WSL</div>
      <div id="nt-wsl-list" class="nt-wsl-list">
        <span class="nt-loading">Detecting distros...</span>
      </div>

      <div class="nt-section-label">Window</div>
      <div id="nt-window-row"></div>

      <div class="nt-section-label">Saved connections</div>
      <div id="nt-ssh-saved-list" class="nt-ssh-saved-list"></div>

      <div class="nt-section-label">SSH</div>
      <form id="nt-ssh-form" class="nt-ssh-form" autocomplete="off">
        <input id="nt-ssh-name" type="text" placeholder="Connection name (optional)" spellcheck="false" />
        <div class="nt-ssh-row">
          <input id="nt-ssh-host" type="text" placeholder="user@host or host" spellcheck="false" />
          <input id="nt-ssh-port" type="number" placeholder="Port (22)" min="1" max="65535" />
        </div>
        <input id="nt-ssh-key" type="text" placeholder="SSH key path, e.g. ~/.ssh/id_rsa (optional)" spellcheck="false" />
        <label class="nt-ssh-default-label nt-ssh-toggle-row">
          <input type="checkbox" id="nt-ssh-use-tmux"> Use tmux
        </label>
        <div id="nt-ssh-tmux-fields" hidden>
          <div class="nt-ssh-row">
            <select id="nt-ssh-tmux-mode">
              <option value="attach">Restore existing session</option>
              <option value="create">Create new session</option>
              <option value="attach_or_create">Restore or create session</option>
            </select>
            <input id="nt-ssh-session" type="text" placeholder="tmux session name" spellcheck="false" />
          </div>
        </div>
        <div class="nt-ssh-actions">
          <label class="nt-ssh-default-label">
            <input type="checkbox" id="nt-ssh-set-default"> Set as default
          </label>
          <div class="nt-ssh-action-buttons">
            <button type="button" id="nt-ssh-save">Save</button>
            <button type="submit" id="nt-ssh-connect">Connect</button>
          </div>
        </div>
        <div id="nt-ssh-form-state" class="nt-ssh-form-state"></div>
      </form>
    `;

    document.body.appendChild(popover);

    function closePopover() {
      popover.remove();
      document.removeEventListener('click', onOutside);
    }

    const localTarget = { type: 'local' };
    const localBtn = document.createElement('button');
    localBtn.className = 'nt-item nt-item-local';
    localBtn.innerHTML = '<span class="nt-icon">+</span> Local (PowerShell / cmd)';
    localBtn.addEventListener('click', () => { closePopover(); createTab(localTarget); });
    popover.querySelector('#nt-local-row').appendChild(makeItemRow(localTarget, localBtn, closePopover));

    const newWinBtn = document.createElement('button');
    newWinBtn.className = 'nt-item';
    newWinBtn.innerHTML = '<span class="nt-icon">&#x2750;</span> New window';
    newWinBtn.addEventListener('click', async () => {
      closePopover();
      try { await invoke('create_app_window'); }
      catch (err) { showError(`Could not open window: ${err}`); }
    });
    popover.querySelector('#nt-window-row')?.appendChild(newWinBtn);

    const anchor = getAnchorElement();
    const rect = anchor.getBoundingClientRect();
    popover.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    popover.style.left = `${rect.left}px`;
    popover.style.maxHeight = `${rect.top - 12}px`;
    popover.style.overflowY = 'auto';

    const sshSavedList = popover.querySelector('#nt-ssh-saved-list');
    const sshNameInput = popover.querySelector('#nt-ssh-name');
    const sshHostInput = popover.querySelector('#nt-ssh-host');
    const sshPortInput = popover.querySelector('#nt-ssh-port');
    const sshKeyInput = popover.querySelector('#nt-ssh-key');
    const sshUseTmuxInput = popover.querySelector('#nt-ssh-use-tmux');
    const sshTmuxFields = popover.querySelector('#nt-ssh-tmux-fields');
    const sshTmuxModeInput = popover.querySelector('#nt-ssh-tmux-mode');
    const sshSessionInput = popover.querySelector('#nt-ssh-session');
    const sshDefaultInput = popover.querySelector('#nt-ssh-set-default');
    const sshSaveBtn = popover.querySelector('#nt-ssh-save');
    const sshFormState = popover.querySelector('#nt-ssh-form-state');
    const formRefs = {
      nameInput: sshNameInput,
      hostInput: sshHostInput,
      portInput: sshPortInput,
      keyInput: sshKeyInput,
      useTmuxInput: sshUseTmuxInput,
      tmuxFields: sshTmuxFields,
      sessionModeInput: sshTmuxModeInput,
      sessionInput: sshSessionInput,
      defaultInput: sshDefaultInput,
      saveBtn: sshSaveBtn,
      formState: sshFormState,
    };

    const parseConnectionTarget = () => buildConnectionTargetFromFields({
      name: formRefs.nameInput.value,
      host: formRefs.hostInput.value,
      port: formRefs.portInput.value,
      identityFile: formRefs.keyInput.value,
      useTmux: formRefs.useTmuxInput.checked,
      sessionMode: formRefs.sessionModeInput.value,
      sessionName: formRefs.sessionInput.value,
    });

    const updateTmuxFieldVisibility = () => {
      formRefs.tmuxFields.hidden = !formRefs.useTmuxInput.checked;
      formRefs.sessionInput.placeholder = formRefs.sessionModeInput.value === REMOTE_TMUX_SESSION_MODES.CREATE
        ? 'tmux session name for the new session'
        : 'tmux session name';
    };

    const clearConnectionForm = () => {
      formRefs.nameInput.value = '';
      formRefs.hostInput.value = '';
      formRefs.portInput.value = '';
      formRefs.keyInput.value = '';
      formRefs.useTmuxInput.checked = false;
      formRefs.sessionModeInput.value = REMOTE_TMUX_SESSION_MODES.ATTACH;
      formRefs.sessionInput.value = '';
      formRefs.defaultInput.checked = false;
      updateTmuxFieldVisibility();
    };

    const updateConnectionFormState = () => {
      if (editingSavedSshId) {
        const existing = savedSshTargets.find((entry) => entry.id === editingSavedSshId);
        formRefs.formState.textContent = existing ? `Editing ${sshTargetDisplayName(existing)}` : 'Editing saved connection';
        formRefs.formState.classList.add('is-editing');
        formRefs.saveBtn.textContent = 'Update';
        return;
      }

      const tmuxMode = formRefs.sessionModeInput.value;
      formRefs.formState.textContent = formRefs.useTmuxInput.checked
        ? (tmuxMode === REMOTE_TMUX_SESSION_MODES.CREATE
          ? 'Connect over SSH and create a named tmux session on the remote host.'
          : tmuxMode === REMOTE_TMUX_SESSION_MODES.ATTACH
            ? 'Connect over SSH and restore a named tmux session on the remote host.'
            : 'Connect over SSH and restore or create a named tmux session on the remote host.')
        : 'Save a plain SSH shell connection to keep it in the picker.';
      formRefs.formState.classList.remove('is-editing');
      formRefs.saveBtn.textContent = 'Save';
    };

    const fillConnectionForm = (target, { editingId = null, preserveDefault = false } = {}) => {
      const normalized = normalizeSshTarget(target);
      if (!normalized) return;
      editingSavedSshId = editingId;
      clearConnectionForm();
      formRefs.nameInput.value = normalized.name ?? '';
      formRefs.hostInput.value = normalized.user ? `${normalized.user}@${normalized.host}` : normalized.host;
      formRefs.portInput.value = normalized.port ?? '';
      formRefs.keyInput.value = normalized.identity_file ?? '';
      formRefs.useTmuxInput.checked = normalized.type === 'remote_tmux';
      formRefs.sessionModeInput.value = normalized.type === 'remote_tmux'
        ? normalized.session_mode ?? REMOTE_TMUX_SESSION_MODES.ATTACH_OR_CREATE
        : REMOTE_TMUX_SESSION_MODES.ATTACH;
      formRefs.sessionInput.value = normalized.type === 'remote_tmux' ? normalized.session_name : '';
      formRefs.defaultInput.checked = preserveDefault ? formRefs.defaultInput.checked : isDefaultTarget(normalized);
      updateTmuxFieldVisibility();
      updateConnectionFormState();
    };

    const validateConnectionTarget = (target) => {
      if (target) return null;
      if (!formRefs.hostInput.value.trim()) return 'SSH host is required. Use host or user@host.';
      if (formRefs.useTmuxInput.checked && !formRefs.sessionInput.value.trim()) {
        return 'tmux session name is required when Use tmux is enabled.';
      }
      return 'SSH host is required. Use host or user@host.';
    };

    const renderSavedSshTargets = () => {
      sshSavedList.innerHTML = '';
      if (savedSshTargets.length === 0) {
        sshSavedList.innerHTML = '<span class="nt-empty">Saved SSH and remote tmux connections will show up here.</span>';
        updateConnectionFormState();
        return;
      }

      for (const entry of savedSshTargets) {
        const row = document.createElement('div');
        row.className = 'nt-saved-ssh-row';

        const connectBtn = document.createElement('button');
        connectBtn.className = 'nt-saved-ssh-main';
        connectBtn.innerHTML = `
          <span class="nt-saved-ssh-title">${escHtml(sshTargetDisplayName(entry))}</span>
          <span class="nt-saved-ssh-detail">${escHtml(sshTargetDetailLabel(entry))}</span>
        `;
        connectBtn.addEventListener('click', () => {
          closePopover();
          createTab(entry);
        });

        const actions = document.createElement('div');
        actions.className = 'nt-saved-ssh-actions';

        if (entry.type === 'remote_tmux') {
          const workspaceBtn = document.createElement('button');
          workspaceBtn.className = 'nt-saved-ssh-action';
          workspaceBtn.title = 'Open saved remote tmux profile in a dedicated workspace';
          workspaceBtn.textContent = 'Workspace';
          workspaceBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            closePopover();
            void openRemoteTmuxWorkspaceFromProfile(entry);
          });
          actions.appendChild(workspaceBtn);
        }

        const editBtn = document.createElement('button');
        editBtn.className = 'nt-saved-ssh-action';
        editBtn.title = 'Edit saved connection';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          fillConnectionForm(entry, { editingId: entry.id });
          formRefs.hostInput.focus();
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'nt-saved-ssh-action danger';
        deleteBtn.title = 'Delete saved connection';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          savedSshTargets = savedSshTargets.filter((candidate) => candidate.id !== entry.id);
          saveSavedSshTargets(savedSshTargets);
          if (editingSavedSshId === entry.id) {
            editingSavedSshId = null;
            clearConnectionForm();
          }
          renderSavedSshTargets();
        });

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        actions.appendChild(makeStarBtn(entry, closePopover));
        row.appendChild(connectBtn);
        row.appendChild(actions);
        sshSavedList.appendChild(row);
      }

      updateConnectionFormState();
    };

    const saveConnectionProfile = () => {
      const target = parseConnectionTarget();
      const validationError = validateConnectionTarget(target);
      if (validationError) {
        showError(validationError);
        (formRefs.useTmuxInput.checked && !formRefs.sessionInput.value.trim() ? formRefs.sessionInput : formRefs.hostInput)?.focus();
        return null;
      }

      const nextEntry = {
        id: editingSavedSshId ?? crypto.randomUUID(),
        ...target,
      };
      const existingIndex = savedSshTargets.findIndex((entry) => entry.id === nextEntry.id);
      if (existingIndex >= 0) savedSshTargets.splice(existingIndex, 1, nextEntry);
      else savedSshTargets.unshift(nextEntry);
      saveSavedSshTargets(savedSshTargets);
      editingSavedSshId = nextEntry.id;
      if (formRefs.defaultInput.checked) {
        setDefaultTarget(nextEntry);
        defaultTarget = nextEntry;
      }
      renderSavedSshTargets();
      return nextEntry;
    };

    const wslList = popover.querySelector('#nt-wsl-list');
    try {
      const distros = await invoke('list_wsl_distros');
      if (distros.length === 0) {
        wslList.innerHTML = '<span class="nt-empty">WSL not installed</span>';
      } else {
        wslList.innerHTML = '';
        for (const distro of distros) {
          const target = { type: 'wsl', distro: distro.name };
          const btn = document.createElement('button');
          btn.className = 'nt-item';
          btn.innerHTML = `<span class="nt-icon">🐧</span> ${distro.name}${distro.is_default ? ' <em>(default wsl)</em>' : ''}`;
          btn.addEventListener('click', () => { closePopover(); createTab(target); });
          wslList.appendChild(makeItemRow(target, btn, closePopover));
        }
      }
    } catch {
      wslList.innerHTML = '<span class="nt-empty">WSL unavailable</span>';
    }

    if (defaultTarget.type === 'ssh' || defaultTarget.type === 'remote_tmux') {
      fillConnectionForm(defaultTarget, { preserveDefault: true });
      formRefs.defaultInput.checked = true;
    }

    renderSavedSshTargets();
    updateTmuxFieldVisibility();
    updateConnectionFormState();

    sshSaveBtn.addEventListener('click', () => { saveConnectionProfile(); });
    sshUseTmuxInput.addEventListener('change', () => {
      updateTmuxFieldVisibility();
      updateConnectionFormState();
    });
    sshTmuxModeInput.addEventListener('change', () => {
      updateTmuxFieldVisibility();
      updateConnectionFormState();
    });

    popover.querySelector('#nt-ssh-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const target = parseConnectionTarget();
      const validationError = validateConnectionTarget(target);
      if (validationError) {
        showError(validationError);
        (sshUseTmuxInput.checked && !sshSessionInput.value.trim() ? sshSessionInput : sshHostInput).focus();
        return;
      }
      if (sshDefaultInput.checked) {
        setDefaultTarget(target);
        defaultTarget = target;
      }
      closePopover();
      createTab(target);
    });

    const onOutside = (event) => {
      const trigger = getAnchorElement();
      if (!popover.contains(event.target) && event.target !== trigger) closePopover();
    };
    setTimeout(() => document.addEventListener('click', onOutside), 0);
  }

  return { showNewTabPopover };
}
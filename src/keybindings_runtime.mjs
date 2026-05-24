// wmux keybindings runtime
//
// Phase A: pure refactor of the big keydown if-cascade that used to live in
// main.js. Same defaults, zero user-facing behavior change. The registry
// drives dispatch; the runtime returns an object with `register` (for setup)
// and `dispatch` (for the document-level keydown handler).
//
// Later stages will add:
//   - JSON-file overrides loaded from the wmux app data dir
//   - Settings UI for view/rebind/reset
//   - Conflict detection at registration time
//   - Hot-reload when the JSON file changes
//
// Design notes:
//   * Chord normalization is `ctrl+alt+shift+meta+<key>`, modifiers
//     alphabetical, key lowercased. e.g. `ctrl+shift+l`, `ctrl+alt+arrowleft`.
//   * A command can have multiple default bindings (e.g. paste = `ctrl+v` AND
//     `shift+insert`). The dispatcher walks the bindings map, so a single
//     command can be invoked by any of its registered chords.
//   * Each handler returns `true` / `undefined` if it handled the event
//     (we then `preventDefault()`), or `false` if the event should be allowed
//     to fall through (e.g. `Ctrl+L` should only consume the key when there's
//     actually a browser pane to focus).
//   * Commands have an optional `shouldRun()` predicate — a quick gate before
//     calling the handler. Same `true/false` semantics: false = fall through.

export function createKeybindingsRuntime() {
  // commandId -> { id, label, defaultBindings, handler, shouldRun }
  const commands = new Map();
  // chord string -> commandId
  const bindings = new Map();

  function chordFromEvent(e) {
    // Use Tab as a special case — DOM gives event.key === 'Tab' for the key
    // and we want it to match a single 'tab' token in the chord.
    let key = e.key;
    if (typeof key !== 'string') return null;
    if (key.length === 1) key = key.toLowerCase();
    else key = key.toLowerCase();
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey) parts.push('meta');
    parts.push(key);
    return parts.join('+');
  }

  function register({ id, label, defaultBindings, handler, shouldRun }) {
    if (!id) throw new Error('keybinding command needs an id');
    if (typeof handler !== 'function') throw new Error(`command ${id} needs a handler`);
    const chords = Array.isArray(defaultBindings) ? defaultBindings : [defaultBindings].filter(Boolean);
    commands.set(id, { id, label: label ?? id, defaultBindings: chords, handler, shouldRun });
    for (const chord of chords) {
      // First-registered wins on conflict; later registrations are recorded as
      // conflicts (logged below). This matches the legacy if-cascade ordering.
      if (bindings.has(chord)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[keybindings] chord "${chord}" already bound to "${bindings.get(chord)}" — ignoring duplicate from "${id}"`,
        );
        continue;
      }
      bindings.set(chord, id);
    }
  }

  // Normalize a chord string so user input matches what `chordFromEvent`
  // produces. Accepts "Ctrl+Shift+L", "ctrl + shift + l", "cmd+k", etc.
  function normalizeChord(chord) {
    if (typeof chord !== 'string') return null;
    const tokens = chord
      .split('+')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (tokens.length === 0) return null;
    const modSet = new Set();
    let key = null;
    for (const tok of tokens) {
      if (tok === 'ctrl' || tok === 'control') modSet.add('ctrl');
      else if (tok === 'alt' || tok === 'option' || tok === 'opt') modSet.add('alt');
      else if (tok === 'shift') modSet.add('shift');
      else if (tok === 'meta' || tok === 'cmd' || tok === 'command' || tok === 'win') modSet.add('meta');
      else key = tok;
    }
    if (!key) return null;
    const parts = [];
    if (modSet.has('ctrl')) parts.push('ctrl');
    if (modSet.has('alt')) parts.push('alt');
    if (modSet.has('shift')) parts.push('shift');
    if (modSet.has('meta')) parts.push('meta');
    parts.push(key);
    return parts.join('+');
  }

  // Replace the chord set for one or more commands. Used by Stage B to apply
  // user overrides from `keybindings.json`. Shape:
  //   { "pane.split.horizontal": ["ctrl+/"], "panel.activity-log.toggle": [] }
  // - Empty array means "unbind this command."
  // - Missing commands keep their defaults (callers should pass only changes).
  // - Unknown command ids are logged and skipped.
  // Returns { applied: string[], unknown: string[], conflicts: string[] }.
  function applyOverrides(overrides) {
    if (!overrides || typeof overrides !== 'object') {
      return { applied: [], unknown: [], conflicts: [] };
    }
    const applied = [];
    const unknown = [];
    const conflicts = [];
    for (const [commandId, rawChords] of Object.entries(overrides)) {
      const cmd = commands.get(commandId);
      if (!cmd) {
        unknown.push(commandId);
        continue;
      }
      const chordList = Array.isArray(rawChords) ? rawChords : [rawChords].filter(Boolean);
      const normalized = chordList
        .map(normalizeChord)
        .filter((c) => c != null);
      // Drop every existing chord that points at this command.
      for (const [chord, ownerId] of [...bindings.entries()]) {
        if (ownerId === commandId) bindings.delete(chord);
      }
      // Wire up the override chords. On conflict, the existing owner wins —
      // this is documented to the user via the returned `conflicts` list so
      // a future Stage C UI can surface it.
      for (const chord of normalized) {
        if (bindings.has(chord)) {
          conflicts.push(`${commandId} ↔ ${bindings.get(chord)} on "${chord}"`);
          // eslint-disable-next-line no-console
          console.warn(
            `[keybindings] override "${chord}" for "${commandId}" conflicts with "${bindings.get(chord)}" — dropping the override`,
          );
          continue;
        }
        bindings.set(chord, commandId);
      }
      cmd.currentBindings = normalized;
      applied.push(commandId);
    }
    return { applied, unknown, conflicts };
  }

  function dispatch(event) {
    const chord = chordFromEvent(event);
    if (!chord) return;
    const commandId = bindings.get(chord);
    if (!commandId) return;
    const cmd = commands.get(commandId);
    if (!cmd) return;
    if (cmd.shouldRun && !cmd.shouldRun(event)) return;
    const result = cmd.handler(event);
    // Default: handlers consume the event. Opt out with explicit `return false`.
    if (result === false) return;
    event.preventDefault();
  }

  // Used by Stage B (file-based overrides) and Stage C (settings UI).
  // Reports each command's defaults *and* its currently-active chord set
  // (which differs from defaults once `applyOverrides` runs).
  function snapshot() {
    const activeByCommand = new Map();
    for (const [chord, commandId] of bindings.entries()) {
      if (!activeByCommand.has(commandId)) activeByCommand.set(commandId, []);
      activeByCommand.get(commandId).push(chord);
    }
    return [...commands.values()].map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      defaults: cmd.defaultBindings,
      bindings: activeByCommand.get(cmd.id) ?? [],
    }));
  }

  // Restore a single command to its default chord set. Returns the chords
  // that ended up active for it (same as defaults minus any that conflict
  // with a chord owned by some other command).
  function restoreDefaults(commandId) {
    const cmd = commands.get(commandId);
    if (!cmd) return [];
    // Drop existing chords for this command first.
    for (const [chord, ownerId] of [...bindings.entries()]) {
      if (ownerId === commandId) bindings.delete(chord);
    }
    const result = [];
    for (const chord of cmd.defaultBindings) {
      if (bindings.has(chord)) continue;
      bindings.set(chord, commandId);
      result.push(chord);
    }
    cmd.currentBindings = result;
    return result;
  }

  // Drop ALL overrides — restore every command to its defaults. Used by the
  // settings UI "Reset all to defaults" button.
  function restoreAllDefaults() {
    bindings.clear();
    for (const cmd of commands.values()) {
      for (const chord of cmd.defaultBindings) {
        if (bindings.has(chord)) continue;
        bindings.set(chord, cmd.id);
      }
      cmd.currentBindings = cmd.defaultBindings.slice();
    }
  }

  return {
    register,
    dispatch,
    snapshot,
    chordFromEvent,
    applyOverrides,
    normalizeChord,
    restoreDefaults,
    restoreAllDefaults,
  };
}

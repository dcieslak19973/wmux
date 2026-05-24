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
  // For Phase A it's just here to keep the API stable.
  function snapshot() {
    return [...commands.values()].map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      bindings: cmd.defaultBindings,
    }));
  }

  return { register, dispatch, snapshot, chordFromEvent };
}

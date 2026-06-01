/**
 * Syntax check for the main frontend modules.
 *
 * Uses `node --input-type=module --check` (parse-only, no execution, no
 * import resolution) so the tests run in ~10 ms even though the modules
 * import from @tauri-apps and the browser DOM.
 *
 * Catches the class of bug that broke the app on 2026-06-01: an `await`
 * expression inside a non-async arrow function (`handler: () => { await … }`)
 * is a SyntaxError in strict-mode ESM and prevents the whole module from
 * loading, breaking the entire UI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse a file as ESM using node --check (syntax only, no execution).
 * Returns { ok, stderr }.
 */
function checkEsm(relPath) {
  const src = readFileSync(join(root, relPath));
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: src,
    encoding: 'utf8',
  });
  return { ok: result.status === 0, stderr: result.stderr ?? '' };
}

// ── main.js (.js — must be piped as ESM; Vite treats it as a module) ─────────

test('src/main.js has no syntax errors', () => {
  const { ok, stderr } = checkEsm('src/main.js');
  assert.ok(ok, `Syntax error in src/main.js:\n${stderr}`);
});

// ── side-effect-free helper modules (.mjs) ────────────────────────────────────

const modules = [
  'src/worktree_state.mjs',
  'src/pane_init.mjs',
  'src/agent_sidebar_runtime.mjs',
  'src/ui_panels_runtime.mjs',
  'src/layout_state.mjs',
  'src/layout_runtime.mjs',
  'src/terminal_restore.mjs',
  'src/connection_targets.mjs',
];

for (const mod of modules) {
  test(`${mod} has no syntax errors`, () => {
    const { ok, stderr } = checkEsm(mod);
    assert.ok(ok, `Syntax error in ${mod}:\n${stderr}`);
  });
}

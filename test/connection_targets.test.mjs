import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConnectionTargetFromFields,
  defaultTargetLabel,
  normalizeSshTarget,
  sshTargetsEqual,
} from '../src/connection_targets.mjs';

test('buildConnectionTargetFromFields creates plain ssh targets from picker fields', () => {
  const target = buildConnectionTargetFromFields({
    name: 'Build shell',
    host: 'dev@example.com',
    port: '2222',
    identityFile: 'C:/keys/dev.pem',
  });

  assert.deepEqual(target, {
    type: 'ssh',
    name: 'Build shell',
    host: 'example.com',
    user: 'dev',
    port: 2222,
    identity_file: 'C:/keys/dev.pem',
  });
});

test('buildConnectionTargetFromFields keeps remote tmux distinct from plain ssh', () => {
  const target = buildConnectionTargetFromFields({
    name: 'Team session',
    host: 'ops@example.com',
    port: '',
    identityFile: '',
    useTmux: true,
    sessionMode: 'attach',
    sessionName: 'team-shell',
  });

  assert.deepEqual(target, {
    type: 'remote_tmux',
    name: 'Team session',
    host: 'example.com',
    user: 'ops',
    port: null,
    identity_file: null,
    session_name: 'team-shell',
    session_mode: 'attach',
  });
  assert.equal(defaultTargetLabel(target), 'Team session');
  assert.equal(sshTargetsEqual(target, normalizeSshTarget({
    type: 'remote_tmux',
    name: 'Other label',
    host: 'example.com',
    user: 'ops',
    session_name: 'team-shell',
    session_mode: 'attach',
  })), true);
});

test('buildConnectionTargetFromFields rejects remote tmux profiles without session name', () => {
  const target = buildConnectionTargetFromFields({
    host: 'ops@example.com',
    useTmux: true,
    sessionMode: 'create',
    sessionName: '',
  });

  assert.equal(target, null);
});
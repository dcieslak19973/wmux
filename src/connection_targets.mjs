export const REMOTE_TMUX_SESSION_MODES = {
  ATTACH: 'attach',
  CREATE: 'create',
  ATTACH_OR_CREATE: 'attach_or_create',
};

export function normalizeRemoteTmuxSessionMode(value) {
  const mode = String(value ?? '').trim();
  if (mode === REMOTE_TMUX_SESSION_MODES.ATTACH || mode === REMOTE_TMUX_SESSION_MODES.CREATE) return mode;
  return REMOTE_TMUX_SESSION_MODES.ATTACH_OR_CREATE;
}

export function normalizeSshTarget(target) {
  if (!target || (target.type !== 'ssh' && target.type !== 'remote_tmux')) return null;
  const host = String(target.host ?? '').trim();
  if (!host) return null;
  const user = String(target.user ?? '').trim() || null;
  const name = String(target.name ?? '').trim() || null;
  const identityFile = String(target.identity_file ?? '').trim() || null;
  const parsedPort = Number(target.port);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : null;
  if (target.type === 'remote_tmux') {
    const sessionName = String(target.session_name ?? '').trim();
    if (!sessionName) return null;
    return {
      type: 'remote_tmux',
      name,
      host,
      user,
      port,
      identity_file: identityFile,
      session_name: sessionName,
      session_mode: normalizeRemoteTmuxSessionMode(target.session_mode),
    };
  }
  return {
    type: 'ssh',
    name,
    host,
    user,
    port,
    identity_file: identityFile,
  };
}

export function sshTargetsEqual(left, right) {
  const a = normalizeSshTarget(left);
  const b = normalizeSshTarget(right);
  if (!a || !b) return false;
  return a.type === b.type
    && a.host === b.host
    && a.user === b.user
    && a.port === b.port
    && a.identity_file === b.identity_file
    && ((a.type === 'remote_tmux' && b.type === 'remote_tmux')
      ? a.session_name === b.session_name && a.session_mode === b.session_mode
      : true);
}

export function sshTargetConnectionLabel(target) {
  const normalized = normalizeSshTarget(target);
  if (!normalized) return 'SSH';
  const hostPart = normalized.user ? `${normalized.user}@${normalized.host}` : normalized.host;
  return normalized.port ? `${hostPart}:${normalized.port}` : hostPart;
}

export function sshTargetDisplayName(target) {
  const normalized = normalizeSshTarget(target);
  if (!normalized) return 'SSH';
  if (normalized.name) return normalized.name;
  const label = sshTargetConnectionLabel(normalized);
  if (normalized.type === 'remote_tmux') return `${label} [tmux:${normalized.session_name}]`;
  return label;
}

export function sshTargetDetailLabel(target) {
  const normalized = normalizeSshTarget(target);
  if (!normalized) return 'SSH';
  const label = sshTargetConnectionLabel(normalized);
  if (normalized.type === 'remote_tmux') {
    const mode = normalized.session_mode === REMOTE_TMUX_SESSION_MODES.CREATE
      ? 'create'
      : normalized.session_mode === REMOTE_TMUX_SESSION_MODES.ATTACH
        ? 'restore'
        : 'create-or-attach';
    return `${label} · tmux:${normalized.session_name} · ${mode}`;
  }
  return label;
}

export function getTargetKind(target) {
  if (!target || target.type === 'local') return 'local';
  if (target.type === 'wsl') return 'wsl';
  if (target.type === 'remote_tmux') return 'remote_tmux';
  if (target.type === 'ssh') return 'ssh';
  return 'local';
}

export function defaultTargetLabel(target) {
  if (!target || target.type === 'local') return 'Local';
  if (target.type === 'wsl') return target.distro ?? 'WSL';
  if (target.type === 'ssh' || target.type === 'remote_tmux') return sshTargetDisplayName(target);
  return 'Local';
}

export function buildConnectionTargetFromFields(fields = {}) {
  const raw = String(fields.host ?? '').trim();
  if (!raw) return null;

  let user = null;
  let host = raw;
  if (raw.includes('@')) {
    const parts = raw.split('@', 2);
    user = parts[0]?.trim() || null;
    host = parts[1]?.trim() || '';
  }

  const useTmux = !!fields.useTmux;
  return normalizeSshTarget(useTmux
    ? {
        type: 'remote_tmux',
        name: String(fields.name ?? '').trim() || null,
        host,
        user,
        port: Number.parseInt(fields.port ?? '', 10),
        identity_file: String(fields.identityFile ?? '').trim() || null,
        session_name: String(fields.sessionName ?? '').trim() || null,
        session_mode: normalizeRemoteTmuxSessionMode(fields.sessionMode),
      }
    : {
        type: 'ssh',
        name: String(fields.name ?? '').trim() || null,
        host,
        user,
        port: Number.parseInt(fields.port ?? '', 10),
        identity_file: String(fields.identityFile ?? '').trim() || null,
      });
}
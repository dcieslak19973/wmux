import { getTargetKind } from './connection_targets.mjs';

export function stripTerminalControlSequences(value) {
  return String(value ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r/g, '');
}

export function normalizeTerminalTranscript(value) {
  const stripped = stripTerminalControlSequences(value).replace(/\x07/g, '');
  let result = '';

  for (const ch of stripped) {
    if (ch === '\b') {
      result = result.slice(0, -1);
      continue;
    }
    if (ch === '\n' || ch === '\t' || ch >= ' ') {
      result += ch;
    }
  }

  return result;
}

export function stripTerminalStartupResetSequences(value) {
  return String(value ?? '')
    .replace(/\x1bc/g, '')
    .replace(/\x1b\[2J/g, '')
    .replace(/\x1b\[3J/g, '')
    .replace(/\x1b\[H/g, '')
    .replace(/\x1b\[\?1049[hl]/g, '')
    .replace(/\x1b\[\?47[hl]/g, '')
    .replace(/\x1b\[\?1047[hl]/g, '');
}

function lastMatch(value, regex) {
  const matches = [...String(value ?? '').matchAll(regex)];
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function inferWindowsCwd(value) {
  const psMatch = lastMatch(value, /PS\s+([A-Za-z]:\\[^>\r\n]*?)>\s*/gi);
  if (psMatch?.[1]) return psMatch[1].trim();

  const cmdMatch = lastMatch(value, /(^|\s)([A-Za-z]:\\[^>\r\n]*?)>\s*/gmi);
  if (cmdMatch?.[2]) return cmdMatch[2].trim();

  return '';
}

function inferPosixCwd(value) {
  const bashMatch = lastMatch(
    value,
    /(?:\([^)]*\)\s*)?[\w.@-]+@[\w.-]+:((?:~|\/)[^#$%\r\n]*?)\s*[#$%]\s*/g,
  );
  if (bashMatch?.[1]) return bashMatch[1].trim();
  return '';
}

export function inferRecentCwdsFromTerminalTranscript(value, maxCount = 2) {
  const lines = normalizeTerminalTranscript(value)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-50)
    .reverse();

  const cwds = [];

  for (const line of lines) {
    const posixCwd = inferPosixCwd(line);
    if (posixCwd && !cwds.includes(posixCwd)) {
      cwds.push(posixCwd);
      if (cwds.length >= maxCount) break;
      continue;
    }

    const windowsCwd = inferWindowsCwd(line);
    if (windowsCwd && !cwds.includes(windowsCwd)) {
      cwds.push(windowsCwd);
      if (cwds.length >= maxCount) break;
    }
  }

  return cwds;
}

export function inferCwdFromTerminalTranscript(value) {
  return inferRecentCwdsFromTerminalTranscript(value, 1)[0] ?? '';
}

function sanitizePosixCwd(value) {
  const normalized = normalizeTerminalTranscript(value).trim();
  if (!normalized) return '';

  const inferred = inferPosixCwd(normalized);
  if (inferred) return inferred;

  if (/^(?:~|\/)[^\r\n]*$/.test(normalized)
    && !/@[\w.-]+:/.test(normalized)
    && !/[#$%>]/.test(normalized)) {
    return normalized;
  }

  const pathMatches = [...normalized.matchAll(/(?:^|[\s(])((?:~|\/)[^\s#$%>)\r\n]+)/g)];
  return pathMatches.length > 0 ? pathMatches[pathMatches.length - 1][1].trim() : '';
}

function sanitizeWindowsCwd(value) {
  const normalized = normalizeTerminalTranscript(value).trim();
  if (!normalized) return '';

  const inferred = inferWindowsCwd(normalized);
  if (inferred) return inferred;

  if (/^(?:[A-Za-z]:\\|\\\\)[^\r\n]*$/.test(normalized) && !/>\s*$/.test(normalized)) {
    return normalized;
  }

  const pathMatches = [...normalized.matchAll(/((?:[A-Za-z]:\\|\\\\)[^\r\n<>|?*]+)/g)];
  return pathMatches.length > 0 ? pathMatches[pathMatches.length - 1][1].trim() : '';
}

export function sanitizeCwdForTarget(target, value) {
  const kind = getTargetKind(target);
  if (kind === 'wsl' || kind === 'ssh' || kind === 'remote_tmux') {
    return sanitizePosixCwd(value);
  }
  if (kind === 'local') {
    return sanitizeWindowsCwd(value);
  }
  return String(value ?? '').trim();
}

export function normalizeHistoryEntry(value) {
  const normalized = normalizeTerminalTranscript(value).trim();
  if (!normalized) return '';
  if (/^[\[\]();0-9?A-Za-z]*$/.test(normalized)
    && /[\[\]()?]/.test(normalized)
    && !/[\s\\/.:-]/.test(normalized)
    && normalized.length <= 32) {
    return '';
  }
  return normalized;
}
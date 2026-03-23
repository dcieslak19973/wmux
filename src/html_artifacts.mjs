export function buildUrlBanner(document, { url, isOauth = false, onOpen, onDismiss } = {}) {
  const banner = document.createElement('div');
  banner.className = `url-banner${isOauth ? ' url-banner-oauth' : ''}`;

  const iconEl = document.createElement('span');
  iconEl.className = 'url-banner-icon';
  iconEl.textContent = isOauth ? '🔑' : '🔗';

  const textEl = document.createElement('span');
  textEl.className = 'url-banner-text';

  const labelEl = document.createElement('strong');
  labelEl.textContent = isOauth ? 'OAuth redirect detected' : 'Local server';

  const urlEl = document.createElement('span');
  urlEl.className = 'url-banner-url';
  urlEl.title = url;
  urlEl.textContent = url.length > 50 ? `${url.slice(0, 47)}...` : url;

  textEl.append(labelEl, urlEl);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'url-banner-open';
  openBtn.textContent = 'Open in browser';
  if (typeof onOpen === 'function') {
    openBtn.addEventListener('click', onOpen);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'url-banner-close';
  closeBtn.title = 'Dismiss';
  closeBtn.textContent = 'x';
  closeBtn.addEventListener('click', () => {
    if (typeof onDismiss === 'function') onDismiss();
    banner.remove();
  });

  banner.append(iconEl, textEl, openBtn, closeBtn);
  return banner;
}

function looksLikeHtmlArtifact(snippet) {
  return /<(?:!doctype\s+html|html|body|head|svg|div|section|article|main|aside|header|footer|nav|canvas|form|table|style|script)\b/i.test(snippet);
}

function normalizeArtifactHtml(raw, kind) {
  const trimmed = raw.trim();
  const baseHead = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
  if (/^<!doctype html/i.test(trimmed) || /^<html\b/i.test(trimmed)) return trimmed;
  if (/^<head\b/i.test(trimmed)) return `<!doctype html><html>${trimmed}<body></body></html>`;
  if (/^<body\b/i.test(trimmed)) return `<!doctype html><html><head>${baseHead}</head>${trimmed}</html>`;
  if (kind === 'svg' || /^<svg\b/i.test(trimmed)) {
    return `<!doctype html><html><head>${baseHead}<title>SVG Artifact</title><style>html,body{margin:0;padding:0;background:#111827;color:#e5e7eb}body{display:flex;align-items:center;justify-content:center;min-height:100vh}svg{max-width:100vw;max-height:100vh}</style></head><body>${trimmed}</body></html>`;
  }
  return `<!doctype html><html><head>${baseHead}</head><body>${trimmed}</body></html>`;
}

function artifactTitleFromHtml(html, kind) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]?.trim()) return titleMatch[1].trim();
  if (kind === 'svg') return 'SVG Artifact';
  if (kind === 'body') return 'Body Fragment';
  if (kind === 'head') return 'Head Fragment';
  if (kind === 'fragment') return 'HTML Fragment';
  return 'HTML Artifact';
}

export function extractHtmlArtifacts(output) {
  if (!output) return [];
  const found = [];
  const seen = new Set();
  const pushCandidate = (candidate, hintedKind = 'html') => {
    const trimmed = candidate?.trim();
    if (!trimmed || !looksLikeHtmlArtifact(trimmed)) return;
    let kind = hintedKind;
    if (/^<!doctype html/i.test(trimmed) || /^<html\b/i.test(trimmed)) kind = 'document';
    else if (/^<svg\b/i.test(trimmed)) kind = 'svg';
    else if (/^<body\b/i.test(trimmed)) kind = 'body';
    else if (/^<head\b/i.test(trimmed)) kind = 'head';
    else if (kind === 'html') kind = 'fragment';
    const html = normalizeArtifactHtml(trimmed, kind);
    if (seen.has(html)) return;
    seen.add(html);
    found.push({ html, kind, title: artifactTitleFromHtml(html, kind) });
  };

  for (const match of output.matchAll(/```(?:\s*(html|svg|xml|xhtml))?\s*([\s\S]*?)```/gi)) {
    pushCandidate(match[2], (match[1] ?? 'html').toLowerCase());
  }
  for (const match of output.matchAll(/<!doctype html[\s\S]*?<\/html>/gi)) pushCandidate(match[0], 'document');
  for (const match of output.matchAll(/<html[\s\S]*?<\/html>/gi)) pushCandidate(match[0], 'document');
  for (const match of output.matchAll(/<body[\s\S]*?<\/body>/gi)) pushCandidate(match[0], 'body');
  for (const match of output.matchAll(/<svg[\s\S]*?<\/svg>/gi)) pushCandidate(match[0], 'svg');
  return found;
}
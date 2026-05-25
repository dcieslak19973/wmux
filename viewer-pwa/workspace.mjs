// wmux PWA workspace landing page.
// Receives a workspace share code in the URL path and a workspace
// secret in the URL fragment (`#t=...`). POSTs to /w/<code>/manifest
// with the secret to get the list of pane shares, then renders each
// as a clickable card. Clicking a card opens the existing single-pane
// viewer at /s/<paneCode>#t=<paneSecret>.

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('workspace-title');
const cardsEl = document.getElementById('pane-cards');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status${cls ? ' ' + cls : ''}`;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const pathParts = window.location.pathname.split('/').filter(Boolean);
const code = pathParts[1] || '';
const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
const params = new URLSearchParams(hash);
const secret = params.get('t') || '';

if (!code || !secret) {
  setStatus('bad share URL — missing code or secret', 'err');
  throw new Error('missing code/secret');
}

(async () => {
  setStatus('fetching manifest…');
  let manifest;
  try {
    const resp = await fetch(`/w/${encodeURIComponent(code)}/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      setStatus(`manifest ${resp.status}: ${text}`, 'err');
      return;
    }
    manifest = await resp.json();
  } catch (err) {
    setStatus(`manifest fetch failed: ${err}`, 'err');
    return;
  }

  titleEl.textContent = manifest.label || 'workspace';
  setStatus(`${manifest.panes.length} pane${manifest.panes.length === 1 ? '' : 's'} shared`, 'ok');

  if (!manifest.panes.length) {
    cardsEl.innerHTML = '<div class="workspace-empty">No panes in this workspace share.</div>';
    return;
  }

  cardsEl.innerHTML = '';
  for (const pane of manifest.panes) {
    const url = `/s/${encodeURIComponent(pane.code)}#t=${encodeURIComponent(pane.secret)}`;
    const card = document.createElement('a');
    card.className = 'workspace-card';
    card.href = url;
    // target=_blank so a tap on one card doesn't lose the workspace
    // landing page — viewer can come back here to switch panes.
    card.target = '_blank';
    card.rel = 'noopener';
    card.innerHTML = `
      <span class="workspace-card-label">${escHtml(pane.label || pane.code)}</span>
      <span class="workspace-card-code mono">${escHtml(pane.code)}</span>
    `;
    cardsEl.appendChild(card);
  }
})();

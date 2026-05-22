// panel_dock.mjs — shared float/dock logic for wmux floating panels.
//
// Panels can float freely over the app or be pinned to #right-dock.
// Dock/float state persists across re-renders within the session.

/** @type {Set<string>} panel IDs currently docked */
const DOCKED = new Set();

/** @type {Map<string, {left: string, top: string}>} saved float positions */
const FLOAT_POSITIONS = new Map();

let _observerSetUp = false;

function ensureObserver() {
  if (_observerSetUp) return;
  const dock = document.getElementById('right-dock');
  if (!dock) return;
  _observerSetUp = true;
  new MutationObserver(() => {
    dock.classList.toggle('has-panels', dock.childElementCount > 0);
  }).observe(dock, { childList: true });
}

/**
 * Make a panel element dockable — adds a pin button, drag-when-floating,
 * and appends the panel to #app (floating) or #right-dock (pinned).
 *
 * @param {HTMLElement} panelEl  - the panel root element
 * @param {HTMLElement} headerEl - the panel's header (drag handle)
 * @param {string} panelId       - stable ID for state persistence (e.g. 'agent-sidebar')
 */
export function makeDockable(panelEl, headerEl, panelId) {
  ensureObserver();

  // Insert pin button as first child of the header's actions container.
  const pinBtn = document.createElement('button');
  pinBtn.className = 'panel-pin-btn';
  pinBtn.title = 'Pin to side dock';
  pinBtn.textContent = '⊞';
  const actionsEl = headerEl.querySelector('[class*="-actions"]') ?? headerEl;
  actionsEl.insertBefore(pinBtn, actionsEl.firstChild);

  let dragActive = false;

  function onDragStart(e) {
    if (e.target.closest('button, input')) return;
    e.preventDefault();
    const parent = panelEl.offsetParent;
    if (!parent) return;
    const pRect = parent.getBoundingClientRect();
    const elRect = panelEl.getBoundingClientRect();
    const startLeft = elRect.left - pRect.left;
    const startTop = elRect.top - pRect.top;
    const startX = e.clientX;
    const startY = e.clientY;
    panelEl.style.left = startLeft + 'px';
    panelEl.style.top = startTop + 'px';
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
    panelEl.style.transform = 'none';
    panelEl.style.transition = 'none';
    document.body.style.userSelect = 'none';
    headerEl.style.cursor = 'grabbing';

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const maxLeft = parent.clientWidth - panelEl.offsetWidth;
      const maxTop = parent.clientHeight - panelEl.offsetHeight;
      panelEl.style.left = Math.max(0, Math.min(startLeft + dx, maxLeft)) + 'px';
      panelEl.style.top = Math.max(0, Math.min(startTop + dy, maxTop)) + 'px';
    }

    function onUp() {
      headerEl.style.cursor = 'grab';
      document.body.style.userSelect = '';
      // Save position for restore after re-render or undock.
      FLOAT_POSITIONS.set(panelId, { left: panelEl.style.left, top: panelEl.style.top });
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function enableDrag() {
    if (dragActive) return;
    dragActive = true;
    headerEl.style.cursor = 'grab';
    headerEl.addEventListener('mousedown', onDragStart);
  }

  function disableDrag() {
    if (!dragActive) return;
    dragActive = false;
    headerEl.style.cursor = '';
    headerEl.removeEventListener('mousedown', onDragStart);
  }

  function dockPanel() {
    // Save current float position before docking.
    if (panelEl.style.left) {
      FLOAT_POSITIONS.set(panelId, { left: panelEl.style.left, top: panelEl.style.top });
    } else {
      const parent = panelEl.offsetParent;
      if (parent) {
        const pRect = parent.getBoundingClientRect();
        const elRect = panelEl.getBoundingClientRect();
        FLOAT_POSITIONS.set(panelId, {
          left: (elRect.left - pRect.left) + 'px',
          top: (elRect.top - pRect.top) + 'px',
        });
      }
    }
    DOCKED.add(panelId);
    ['position', 'left', 'top', 'right', 'bottom', 'width', 'maxHeight', 'transform', 'transition'].forEach((p) => { panelEl.style[p] = ''; });
    document.getElementById('right-dock').appendChild(panelEl);
    pinBtn.textContent = '⊟';
    pinBtn.classList.add('is-pinned');
    pinBtn.title = 'Unpin panel';
    disableDrag();
  }

  function floatPanel() {
    DOCKED.delete(panelId);
    document.getElementById('app').appendChild(panelEl);
    panelEl.style.position = 'absolute';
    const pos = FLOAT_POSITIONS.get(panelId);
    if (pos) {
      panelEl.style.left = pos.left;
      panelEl.style.top = pos.top;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      panelEl.style.transform = 'none';
    }
    pinBtn.textContent = '⊞';
    pinBtn.classList.remove('is-pinned');
    pinBtn.title = 'Pin to side dock';
    enableDrag();
  }

  pinBtn.addEventListener('click', () => {
    if (DOCKED.has(panelId)) floatPanel();
    else dockPanel();
  });

  // Initial placement: restore docked or float state.
  if (DOCKED.has(panelId)) {
    ['position', 'left', 'top', 'right', 'bottom', 'width', 'maxHeight', 'transform', 'transition'].forEach((p) => { panelEl.style[p] = ''; });
    document.getElementById('right-dock').appendChild(panelEl);
    pinBtn.textContent = '⊟';
    pinBtn.classList.add('is-pinned');
    pinBtn.title = 'Unpin panel';
    // dragActive stays false, cursor stays default.
  } else {
    document.getElementById('app').appendChild(panelEl);
    const pos = FLOAT_POSITIONS.get(panelId);
    if (pos) {
      panelEl.style.position = 'absolute';
      panelEl.style.left = pos.left;
      panelEl.style.top = pos.top;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      panelEl.style.transform = 'none';
    }
    enableDrag();
  }
}

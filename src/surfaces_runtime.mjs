export function createSurfaceRuntime({
  invoke,
  document,
  getWindowLabel,
  tabs,
  panes,
  markdownPanes,
  getActiveWorkspaceId,
  getActiveTabId,
  getActivePaneId,
  getActiveBrowserLabel,
  setActiveBrowserLabel,
  getActiveMarkdownLabel,
  setActiveMarkdownLabel,
  getZoomedSurfaceEl,
  setZoomedSurfaceEl,
  clearActiveSurface,
  activatePane,
  activateTab,
  toggleSurfaceZoom,
  collapsePaneBranch,
  fitAndResizePane,
  makeDividerDrag,
  basenameFromPath,
  dirnameFromPath,
  resolveMarkdownPath,
  renderMarkdownHtml,
  highlightMarkdownCodeBlocks,
  escHtml,
  showError,
  updateTabMeta,
  onLayoutChanged,
}) {
  const browserPanes = new Map();

  function syncBrowserVisibility() {
    for (const browser of browserPanes.values()) {
      const tab = tabs.get(browser.tabId);
      const visible = Boolean(
        browser.created
        && tab
        && tab.workspaceId === getActiveWorkspaceId()
        && getActiveTabId() === browser.tabId
        && browser.browserEl.isConnected,
      );
      invoke('set_browser_visible', { label: browser.label, visible }).catch(() => {});
    }
  }

  async function openBrowserSplitForTab(tabId, url = '') {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const paneId = [...tab.paneIds][0];
    if (!paneId) return;
    await splitPaneWithBrowser(paneId, 'h', { url });
  }

  function activateBrowser(label) {
    const state = browserPanes.get(label);
    if (!state) return;

    clearActiveSurface();
    setActiveBrowserLabel(label);
    state.browserEl.classList.add('active-pane');
    const tab = tabs.get(state.tabId);
    if (tab) tab.lastActiveSurfaceEl = state.browserEl;
    onLayoutChanged?.();

    if (state.tabId !== getActiveTabId()) {
      activateTab(state.tabId);
      return;
    }

    syncBrowserVisibility();
  }

  function activateMarkdown(label) {
    const state = markdownPanes.get(label);
    if (!state) return;

    clearActiveSurface();
    setActiveMarkdownLabel(label);
    state.markdownEl.classList.add('active-pane');
    const tab = tabs.get(state.tabId);
    if (tab) tab.lastActiveSurfaceEl = state.markdownEl;
    onLayoutChanged?.();

    if (state.tabId !== getActiveTabId()) {
      activateTab(state.tabId);
      return;
    }

    requestAnimationFrame(() => {
      state.markdownEl.querySelector('.markdown-path')?.focus();
    });
  }

  async function closeBrowserSurface(label, { collapse = true } = {}) {
    const state = browserPanes.get(label);
    if (!state) return;

    state.resizeObserver?.disconnect();
    browserPanes.delete(label);
    const tab = tabs.get(state.tabId);
    tab?.browserLabels?.delete(label);
    if (tab?.lastActiveSurfaceEl === state.browserEl) tab.lastActiveSurfaceEl = null;
    if (tab?.zoomedSurfaceEl === state.browserEl) tab.zoomedSurfaceEl = null;
    if (getZoomedSurfaceEl() === state.browserEl) setZoomedSurfaceEl(null);
    if (getActiveBrowserLabel() === label) setActiveBrowserLabel(null);
    await invoke('close_browser_window', { label }).catch(() => {});

    if (collapse) {
      collapsePaneBranch(state.browserEl);
      requestAnimationFrame(() => {
        for (const [paneId] of panes) fitAndResizePane(paneId);
      });
      updateTabMeta(state.tabId);
    }
    onLayoutChanged?.();
    syncBrowserVisibility();
  }

  function closeMarkdownSurface(label, { collapse = true } = {}) {
    const state = markdownPanes.get(label);
    if (!state) return;

    markdownPanes.delete(label);
    const tab = tabs.get(state.tabId);
    tab?.markdownLabels?.delete(label);
    if (tab?.lastActiveSurfaceEl === state.markdownEl) tab.lastActiveSurfaceEl = null;
    if (tab?.zoomedSurfaceEl === state.markdownEl) tab.zoomedSurfaceEl = null;
    if (getZoomedSurfaceEl() === state.markdownEl) setZoomedSurfaceEl(null);
    if (getActiveMarkdownLabel() === label) setActiveMarkdownLabel(null);

    if (collapse) {
      collapsePaneBranch(state.markdownEl);
      requestAnimationFrame(() => {
        for (const [paneId] of panes) fitAndResizePane(paneId);
      });
      updateTabMeta(state.tabId);
    }
    onLayoutChanged?.();
  }

  async function createMarkdownLeaf(tabId, mountEl, initialState = {}) {
    const label = `markdown-${crypto.randomUUID().slice(0, 8)}`;
    const markdownEl = document.createElement('div');
    markdownEl.className = 'pane-leaf markdown-pane-leaf';
    markdownEl.style.flex = '1 1 0';
    markdownEl.style.minWidth = '0';
    markdownEl.style.minHeight = '0';
    markdownEl.dataset.markdownLabel = label;
    markdownEl.innerHTML = `
      <div class="markdown-bar">
        <input class="markdown-path" placeholder="Enter a markdown file path..." spellcheck="false" />
        <button class="markdown-btn" data-action="reload" title="Reload markdown">&#x21bb;</button>
        <button class="markdown-btn" data-action="zoom" title="Toggle zoom (Ctrl+Alt+Enter)">&#x2922;</button>
        <button class="markdown-btn pane-tb-close" data-action="close" title="Close markdown">&#x2715;</button>
      </div>
      <div class="markdown-body">
        <div class="markdown-empty">Enter a markdown file path and press Enter.</div>
      </div>
    `;
    mountEl.appendChild(markdownEl);

    const pathInput = markdownEl.querySelector('.markdown-path');
    const bodyEl = markdownEl.querySelector('.markdown-body');
    const state = {
      label,
      tabId,
      markdownEl,
      bodyEl,
      pathInput,
      path: initialState.path ?? '',
      baseDir: dirnameFromPath(initialState.path ?? ''),
      source: initialState.source ?? initialState.content ?? '',
      title: initialState.title ?? '',
    };
    markdownPanes.set(label, state);
    tabs.get(tabId)?.markdownLabels?.add(label);

    const renderSource = (source, title = state.title) => {
      state.source = source ?? '';
      state.title = title || basenameFromPath(state.path) || 'Markdown';
      bodyEl.innerHTML = `<article class="markdown-content">${renderMarkdownHtml(state.source)}</article>`;
      highlightMarkdownCodeBlocks(bodyEl);
    };

    const renderError = (message) => {
      bodyEl.innerHTML = `<div class="markdown-error">${escHtml(message)}</div>`;
    };

    const loadPath = async (requestedPath, options = {}) => {
      const resolved = resolveMarkdownPath(requestedPath, options.baseDir ?? state.baseDir);
      if (!resolved) {
        renderError('Enter a markdown file path to load content.');
        return;
      }

      try {
        const source = await invoke('read_text_file', { path: resolved });
        state.path = resolved;
        state.baseDir = dirnameFromPath(resolved);
        pathInput.value = resolved;
        renderSource(source, basenameFromPath(resolved));
        onLayoutChanged?.();
      } catch (err) {
        renderError(String(err));
        showError(`Could not open markdown: ${err}`);
      }
    };

    markdownEl.addEventListener('mousedown', () => activateMarkdown(label));
    pathInput.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      await loadPath(pathInput.value);
    });
    markdownEl.querySelector('[data-action="reload"]').addEventListener('click', async () => {
      if (state.path) await loadPath(state.path, { baseDir: '' });
    });
    markdownEl.querySelector('[data-action="zoom"]').addEventListener('click', () => toggleSurfaceZoom(markdownEl));
    markdownEl.querySelector('[data-action="close"]').addEventListener('click', () => closeMarkdownSurface(label));
    bodyEl.addEventListener('click', async (event) => {
      const link = event.target.closest('a[href]');
      if (!link) return;
      const href = link.getAttribute('href')?.trim() ?? '';
      if (!href || href.startsWith('#')) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(href)) {
        await openBrowserSplitForTab(tabId, href);
        return;
      }
      await loadPath(href, { baseDir: state.baseDir });
    });

    if (state.path) {
      await loadPath(state.path, { baseDir: '' });
    } else if (state.source) {
      renderSource(state.source, state.title);
    }

    activateMarkdown(label);
    onLayoutChanged?.();
    return label;
  }

  async function createBrowserLeaf(tabId, mountEl, initialState = {}) {
    const label = `browser-${crypto.randomUUID().slice(0, 8)}`;
    const browserEl = document.createElement('div');
    browserEl.className = 'pane-leaf browser-pane-leaf';
    browserEl.style.flex = '1 1 0';
    browserEl.style.minWidth = '0';
    browserEl.style.minHeight = '0';
    browserEl.dataset.browserLabel = label;
    browserEl.innerHTML = `
      <div class="browser-bar">
        <button class="browser-btn" id="bb-back-${label}" title="Back (Ctrl+[)" disabled>&#x2190;</button>
        <button class="browser-btn" id="bb-fwd-${label}" title="Forward (Ctrl+])" disabled>&#x2192;</button>
        <button class="browser-btn" id="bb-reload-${label}" title="Reload (Ctrl+R)">&#x21bb;</button>
        <button class="browser-btn" id="bb-zoom-${label}" title="Toggle zoom (Ctrl+Alt+Enter)">&#x2922;</button>
        <input class="browser-url" id="bu-${label}" placeholder="Enter URL…" spellcheck="false" />
        <button class="browser-btn browser-go" id="bg-${label}">Go</button>
        <button class="browser-btn pane-tb-close" id="bc-${label}" title="Close browser">&#x2715;</button>
      </div>
      <div class="browser-placeholder">Enter a URL and press Go</div>
    `;
    mountEl.appendChild(browserEl);

    const urlInput = document.getElementById(`bu-${label}`);
    const backBtn = document.getElementById(`bb-back-${label}`);
    const fwdBtn = document.getElementById(`bb-fwd-${label}`);
    const reloadBtn = document.getElementById(`bb-reload-${label}`);
    const zoomBtn = document.getElementById(`bb-zoom-${label}`);
    const placeholderEl = browserEl.querySelector('.browser-placeholder');

    const browserState = {
      label,
      tabId,
      browserEl,
      history: Array.isArray(initialState.history) ? [...initialState.history] : [],
      historyIndex: Number.isInteger(initialState.historyIndex) ? initialState.historyIndex : -1,
      created: false,
      resizeObserver: null,
      currentUrl: '',
    };
    if (browserState.historyIndex >= browserState.history.length) browserState.historyIndex = browserState.history.length - 1;
    if (browserState.historyIndex < 0 && browserState.history.length > 0) browserState.historyIndex = browserState.history.length - 1;
    if (!initialState.url && browserState.historyIndex >= 0) browserState.currentUrl = browserState.history[browserState.historyIndex] ?? '';
    browserPanes.set(label, browserState);
    tabs.get(tabId)?.browserLabels?.add(label);
    updateTabMeta(tabId);
    onLayoutChanged?.();

    const updateNavButtons = () => {
      backBtn.disabled = browserState.historyIndex <= 0;
      fwdBtn.disabled = browserState.historyIndex < 0 || browserState.historyIndex >= browserState.history.length - 1;
    };

    const navigateTo = (url, { pushHistory = true } = {}) => {
      let full = url.trim();
      if (!full) return;
      if (!full.startsWith('http://') && !full.startsWith('https://')) full = `https://${full}`;
      urlInput.value = full;

      const run = async () => {
        if (!browserState.created) {
          const rect = browserEl.getBoundingClientRect();
          const barH = 36;
          await invoke('create_browser_window', {
            request: {
              window_label: getWindowLabel(),
              label,
              url: full,
              geometry: {
                x: Math.round(rect.left),
                y: Math.round(rect.top + barH),
                width: Math.max(1, Math.round(rect.width)),
                height: Math.max(1, Math.round(rect.height - barH)),
              },
            },
          });
          browserState.created = true;
          placeholderEl?.remove();
          syncBrowserVisibility();
        } else {
          await invoke('navigate_browser', { label, url: full });
        }

        browserState.currentUrl = full;
        if (pushHistory) {
          const nextHistory = browserState.history.slice(0, browserState.historyIndex + 1);
          if (nextHistory[nextHistory.length - 1] !== full) nextHistory.push(full);
          browserState.history = nextHistory;
          browserState.historyIndex = browserState.history.length - 1;
        }
        updateNavButtons();
        onLayoutChanged?.();
      };

      run().catch((err) => showError(`Could not open browser: ${err}`));
    };

    document.getElementById(`bg-${label}`).addEventListener('click', () => navigateTo(urlInput.value));
    urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') navigateTo(event.target.value);
    });
    backBtn.addEventListener('click', () => {
      if (browserState.historyIndex <= 0) return;
      browserState.historyIndex -= 1;
      navigateTo(browserState.history[browserState.historyIndex], { pushHistory: false });
    });
    fwdBtn.addEventListener('click', () => {
      if (browserState.historyIndex >= browserState.history.length - 1) return;
      browserState.historyIndex += 1;
      navigateTo(browserState.history[browserState.historyIndex], { pushHistory: false });
    });
    reloadBtn.addEventListener('click', () => {
      const currentUrl = browserState.history[browserState.historyIndex];
      if (currentUrl) navigateTo(currentUrl, { pushHistory: false });
    });
    zoomBtn.addEventListener('click', () => toggleSurfaceZoom(browserEl));
    document.getElementById(`bc-${label}`).addEventListener('click', async () => closeBrowserSurface(label));

    const browserRO = new ResizeObserver(() => {
      if (!browserState.created) return;
      const rect = browserEl.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 40) return;
      invoke('set_browser_geometry', {
        label,
        x: Math.round(rect.left),
        y: Math.round(rect.top + 36),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height - 36)),
      }).catch(() => {});
    });
    browserState.resizeObserver = browserRO;
    browserRO.observe(browserEl);
    browserEl.addEventListener('mousedown', () => activateBrowser(label));

    const initialUrl = initialState.url || browserState.currentUrl;
    if (initialUrl) requestAnimationFrame(() => navigateTo(initialUrl, { pushHistory: false }));

    syncBrowserVisibility();
    return browserState;
  }

  async function splitPaneWithBrowser(paneId, dir, initialState = {}) {
    const pane = panes.get(paneId);
    if (!pane) return;
    const leafEl = pane.domEl;
    const parentEl = leafEl.parentElement;
    const splitEl = document.createElement('div');
    splitEl.className = `pane-split pane-split-${dir}`;
    leafEl.style.flex = '1 1 0';
    parentEl.replaceChild(splitEl, leafEl);
    splitEl.appendChild(leafEl);
    const dividerEl = document.createElement('div');
    dividerEl.className = `pane-divider pane-divider-${dir}`;
    dividerEl.addEventListener('mousedown', makeDividerDrag(splitEl, dir));
    splitEl.appendChild(dividerEl);
    await createBrowserLeaf(pane.tabId, splitEl, initialState);
    fitAndResizePane(paneId);
    onLayoutChanged?.();
  }

  async function splitPaneWithMarkdown(paneId, dir, initialState = {}) {
    const pane = panes.get(paneId);
    if (!pane) return;
    const leafEl = pane.domEl;
    const parentEl = leafEl.parentElement;
    const splitEl = document.createElement('div');
    splitEl.className = `pane-split pane-split-${dir}`;
    leafEl.style.flex = '1 1 0';
    parentEl.replaceChild(splitEl, leafEl);
    splitEl.appendChild(leafEl);
    const dividerEl = document.createElement('div');
    dividerEl.className = `pane-divider pane-divider-${dir}`;
    dividerEl.addEventListener('mousedown', makeDividerDrag(splitEl, dir));
    splitEl.appendChild(dividerEl);
    await createMarkdownLeaf(pane.tabId, splitEl, initialState);
    fitAndResizePane(paneId);
    onLayoutChanged?.();
  }

  function focusBrowserUrl() {
    const browser = browserPanes.get(getActiveBrowserLabel());
    if (!browser) return false;
    browser.browserEl.querySelector('.browser-url')?.focus();
    return true;
  }

  function browserNavigateRelative(direction) {
    const browser = browserPanes.get(getActiveBrowserLabel());
    if (!browser) return false;
    const delta = direction === 'back' ? -1 : 1;
    const nextIndex = browser.historyIndex + delta;
    if (nextIndex < 0 || nextIndex >= browser.history.length) return true;
    browser.historyIndex = nextIndex;
    const targetUrl = browser.history[nextIndex];
    if (targetUrl) {
      const urlInput = browser.browserEl.querySelector('.browser-url');
      if (urlInput) urlInput.value = targetUrl;
      invoke('navigate_browser', { label: browser.label, url: targetUrl }).catch((err) => showError(`Could not navigate browser: ${err}`));
      browser.currentUrl = targetUrl;
      onLayoutChanged?.();
    }
    return true;
  }

  function reloadActiveBrowser() {
    const browser = browserPanes.get(getActiveBrowserLabel());
    if (!browser?.currentUrl) return false;
    invoke('navigate_browser', { label: browser.label, url: browser.currentUrl }).catch((err) => showError(`Could not reload browser: ${err}`));
    return true;
  }

  return {
    browserPanes,
    syncBrowserVisibility,
    openBrowserSplitForTab,
    activateBrowser,
    activateMarkdown,
    closeBrowserSurface,
    closeMarkdownSurface,
    createMarkdownLeaf,
    createBrowserLeaf,
    splitPaneWithBrowser,
    splitPaneWithMarkdown,
    focusBrowserUrl,
    browserNavigateRelative,
    reloadActiveBrowser,
  };
}
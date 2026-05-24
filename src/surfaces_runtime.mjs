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
    // Browser panes are <iframe> elements inside the main WebView2.
    // Visibility is handled entirely by CSS/DOM — no IPC needed.
  }

  async function openBrowserSplitForTab(tabId, url = '') {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const paneId = [...tab.paneIds][0];
    if (!paneId) return;
    await splitPaneWithBrowser(paneId, 'h', { url });
  }

  function normalizeBrowserUrl(url) {
    const value = String(url ?? '').trim();
    if (!value) return '';
    if (/^(?:https?|file|data|about|blob):/i.test(value)) return value;
    return `https://${value}`;
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

  function closeBrowserSurface(label, { collapse = true } = {}) {
    const state = browserPanes.get(label);
    if (!state) return;

    // If a CEF helper was spawned for this pane, kill it. Idempotent
    // server-side — safe to call when the user already closed the helper
    // window manually.
    if (state.cefLabel) {
      invoke('kill_browser_helper', { label: state.cefLabel }).catch(() => {});
    }

    browserPanes.delete(label);
    const tab = tabs.get(state.tabId);
    tab?.browserLabels?.delete(label);
    if (tab?.lastActiveSurfaceEl === state.browserEl) tab.lastActiveSurfaceEl = null;
    if (tab?.zoomedSurfaceEl === state.browserEl) tab.zoomedSurfaceEl = null;
    if (getZoomedSurfaceEl() === state.browserEl) setZoomedSurfaceEl(null);
    if (getActiveBrowserLabel() === label) setActiveBrowserLabel(null);

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

  function createBrowserLeaf(tabId, mountEl, initialState = {}) {
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
        <button class="browser-btn" id="bb-cef-${label}" title="Open the URL in a real Chromium browser (out-of-process CEF helper). Use this for: (1) sites that block iframe embedding (Google, GitHub, Twitter, etc.), (2) making the page readable by MCP agents via Chrome DevTools Protocol — agents can discover helpers with cef_helper_list and read content with browser_read_content. The helper window appears separately from wmux (in-pane visual embedding requires off-screen rendering, not yet shipped). Once activated, Enter and Go in this pane also route through CEF.">&#x1f310;</button>
        <button class="browser-btn pane-tb-close" id="bc-${label}" title="Close browser">&#x2715;</button>
      </div>
      <div class="browser-placeholder" id="bph-${label}">Enter a URL and press Go</div>
      <iframe class="browser-iframe" id="bif-${label}" style="display:none;" title="Browser"></iframe>
    `;
    mountEl.appendChild(browserEl);

    const urlInput = document.getElementById(`bu-${label}`);
    const backBtn = document.getElementById(`bb-back-${label}`);
    const fwdBtn = document.getElementById(`bb-fwd-${label}`);
    const reloadBtn = document.getElementById(`bb-reload-${label}`);
    const zoomBtn = document.getElementById(`bb-zoom-${label}`);
    const placeholderEl = document.getElementById(`bph-${label}`);
    const iframeEl = document.getElementById(`bif-${label}`);

    const browserState = {
      label,
      tabId,
      browserEl,
      iframeEl,
      history: Array.isArray(initialState.history) ? [...initialState.history] : [],
      historyIndex: Number.isInteger(initialState.historyIndex) ? initialState.historyIndex : -1,
      currentUrl: '',
      // EXPERIMENTAL (spike-only): once the CEF helper has been activated
      // for this pane, the iframe path is locked out so Enter/Go don't
      // load google.com (or any other X-Frame-Options-protected page)
      // into the iframe, where the failure overlaps with the CEF window
      // and makes it impossible to tell which surface is failing.
      cefActive: false,
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

    // Switch this pane into CEF mode and load `full` via the helper. Idempotent
    // for cefActive=true; reuses the helper via CDP navigate when one exists,
    // falls back to a fresh spawn if the navigate fails. Removes the iframe
    // and shows the in-pane indicator on first activation. `reason` is
    // either 'manual' (user clicked 🌐) or 'auto-iframe-blocked' (navigateTo's
    // header check decided the site can't iframe); affects only the indicator
    // copy so the user understands why a popup just appeared.
    const cefHelperForPane = (full, reason = 'manual') => {
      const firstActivation = !browserState.cefActive;
      browserState.cefActive = true;

      // Persistent visual signal in the browser bar so the user can tell
      // at-a-glance that further navigations in this pane will pop out.
      const cefBtn = document.getElementById(`bb-cef-${label}`);
      if (cefBtn) {
        cefBtn.classList.add('cef-active');
        cefBtn.style.background = '#7c6af7';
        cefBtn.style.color = '#fff';
      }

      if (firstActivation) {
        try { iframeEl.remove?.(); } catch (_) {}
        placeholderEl?.remove?.();
        if (!browserEl.querySelector('.cef-active-indicator')) {
          let host = '';
          try { host = new URL(full).hostname; } catch (_) {}
          const indicator = document.createElement('div');
          indicator.className = 'cef-active-indicator';
          indicator.style.cssText = 'padding:16px;color:#d1d5db;font-size:13px;line-height:1.55;max-width:560px';
          if (reason === 'auto-iframe-blocked') {
            indicator.innerHTML =
              '<div style="font-size:15px;color:#fff;margin-bottom:8px">'
              + `&#x1f310; Opened <strong>${host || 'this page'}</strong> in a separate window`
              + '</div>'
              + `<div>${host || 'This site'} doesn't allow being embedded inside other apps `
              + '(it sends <code>X-Frame-Options</code> or a <code>frame-ancestors</code> CSP). '
              + 'wmux launched it in its own Chromium window — drag it wherever you want.</div>'
              + '<div style="margin-top:10px;color:#9ca3af">'
              + 'Any further <strong>Enter</strong> / <strong>Go</strong> in this pane will reuse that window. '
              + 'Close the pane and reopen it to reset to in-pane iframe mode.'
              + '</div>';
          } else {
            indicator.innerHTML =
              '<div style="font-size:15px;color:#fff;margin-bottom:8px">'
              + '&#x1f310; Chromium window active for this pane'
              + '</div>'
              + '<div>You clicked &#x1f310; — the page is rendering in a separate Chromium window. '
              + 'Drag it wherever you want.</div>'
              + '<div style="margin-top:10px;color:#9ca3af">'
              + 'Any further <strong>Enter</strong> / <strong>Go</strong> in this pane will reuse that window. '
              + 'Close the pane and reopen it to reset to in-pane iframe mode.'
              + '</div>';
          }
          browserEl.appendChild(indicator);
        }
      }

      const recordSpawn = (spawned) => {
        browserState.cefLabel = spawned.label;
        browserState.cefPort = spawned.cdp_port;
        const ind = browserEl.querySelector('.cef-active-indicator');
        if (ind && !ind.dataset.labeled) {
          ind.dataset.labeled = '1';
          ind.innerHTML +=
            '<div style="margin-top:14px;padding-top:10px;border-top:1px solid #374151;color:#9ca3af;font-size:11px">'
            + 'For agents (MCP): this page is now readable via '
            + '<code>browser_read_content</code> with the label below.'
            + `<br><code style="color:#4ade80">CEF label: ${spawned.label}</code>`
            + `<br><code style="color:#4ade80">CDP: http://localhost:${spawned.cdp_port}/json</code>`
            + '</div>';
        }
      };

      const spawnFresh = () => {
        invoke('spawn_browser_helper', { windowLabel: getWindowLabel(), url: full })
          .then(recordSpawn)
          .catch((err) => showError(`Could not spawn CEF helper: ${err}`));
      };

      if (browserState.cefLabel) {
        invoke('navigate_browser_helper', { label: browserState.cefLabel, url: full })
          .catch(() => {
            browserState.cefLabel = null;
            spawnFresh();
          });
      } else {
        spawnFresh();
      }
    };

    const navigateTo = (url, { pushHistory = true } = {}) => {
      const full = normalizeBrowserUrl(url);
      if (!full) return;
      urlInput.value = full;

      browserState.currentUrl = full;
      if (pushHistory) {
        const nextHistory = browserState.history.slice(0, browserState.historyIndex + 1);
        if (nextHistory[nextHistory.length - 1] !== full) nextHistory.push(full);
        browserState.history = nextHistory;
        browserState.historyIndex = browserState.history.length - 1;
      }
      updateNavButtons();
      onLayoutChanged?.();

      // Already in CEF mode → straight to the helper.
      if (browserState.cefActive) {
        // Reuse — keep whatever indicator copy is already shown.
        cefHelperForPane(full, 'manual');
        return;
      }

      // Iframe path: kick off the load optimistically, then in parallel ask
      // Rust whether the URL refuses iframe embedding via X-Frame-Options /
      // CSP frame-ancestors. If it does, switch the pane to CEF mode mid-flight
      // so the user never has to manually click 🌐 for a site that was never
      // going to load. Sites that allow iframe pay zero added latency.
      if (iframeEl.style.display === 'none') {
        placeholderEl?.remove();
        iframeEl.style.display = '';
      }
      iframeEl.src = full;

      invoke('check_iframe_compatible', { url: full })
        .then((compatible) => {
          if (compatible) return;
          // Header-based block detected — auto-switch with explanatory copy.
          cefHelperForPane(full, 'auto-iframe-blocked');
        })
        .catch(() => {
          // Network error during the check — leave the iframe alone, the
          // user will see whatever the iframe shows.
        });
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
    document.getElementById(`bb-cef-${label}`).addEventListener('click', () => {
      // Explicit user opt-in to CEF mode for this pane. Same path that
      // navigateTo takes when its header check returns "iframe blocked";
      // delegated to cefHelperForPane to keep the activation logic in one
      // place.
      const target = (urlInput.value || browserState.currentUrl || '').trim();
      const full = normalizeBrowserUrl(target) || 'https://www.google.com/';
      cefHelperForPane(full);
    });
    document.getElementById(`bc-${label}`).addEventListener('click', () => closeBrowserSurface(label));

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
    createBrowserLeaf(pane.tabId, splitEl, initialState);
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
      if (browser.iframeEl) browser.iframeEl.src = targetUrl;
      browser.currentUrl = targetUrl;
      onLayoutChanged?.();
    }
    return true;
  }

  function reloadActiveBrowser() {
    const browser = browserPanes.get(getActiveBrowserLabel());
    if (!browser?.currentUrl || !browser.iframeEl) return false;
    try { browser.iframeEl.contentWindow?.location?.reload(); }
    catch { browser.iframeEl.src = browser.currentUrl; }
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
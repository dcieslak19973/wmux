import { createSurfaceRuntime } from './surfaces_runtime.mjs';

export function createBrowserPaneRuntime(options) {
  const surfaceRuntime = createSurfaceRuntime(options);
  const browserPanes = surfaceRuntime.browserPanes;

  function syncBrowserVisibility() {
    return surfaceRuntime.syncBrowserVisibility();
  }

  async function openBrowserSplitForTab(tabId, url = '') {
    return surfaceRuntime.openBrowserSplitForTab(tabId, url);
  }

  function activateBrowser(label) {
    return surfaceRuntime.activateBrowser(label);
  }

  async function closeBrowserSurface(label, { collapse = true } = {}) {
    return surfaceRuntime.closeBrowserSurface(label, { collapse });
  }

  async function createBrowserLeaf(tabId, mountEl, initialState = {}) {
    return surfaceRuntime.createBrowserLeaf(tabId, mountEl, initialState);
  }

  async function splitPaneWithBrowser(paneId, dir, initialState = {}) {
    return surfaceRuntime.splitPaneWithBrowser(paneId, dir, initialState);
  }

  async function closeBrowserSurfacesForShutdown() {
    const browserLabels = [...browserPanes.keys()];
    if (browserLabels.length === 0) return;
    await Promise.allSettled(
      browserLabels.map((label) => closeBrowserSurface(label, { collapse: false })),
    );
  }

  function focusBrowserUrl() {
    return surfaceRuntime.focusBrowserUrl() ?? false;
  }

  function browserNavigateRelative(direction) {
    return surfaceRuntime.browserNavigateRelative(direction) ?? false;
  }

  function reloadActiveBrowser() {
    return surfaceRuntime.reloadActiveBrowser() ?? false;
  }

  return {
    surfaceRuntime,
    browserPanes,
    syncBrowserVisibility,
    openBrowserSplitForTab,
    activateBrowser,
    closeBrowserSurface,
    createBrowserLeaf,
    splitPaneWithBrowser,
    closeBrowserSurfacesForShutdown,
    focusBrowserUrl,
    browserNavigateRelative,
    reloadActiveBrowser,
  };
}
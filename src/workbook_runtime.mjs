export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/-->/g, '--\\>');
}

function inferColumns(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

export function normalizeWorkbookSpec(spec = {}) {
  const rows = Array.isArray(spec.rows)
    ? spec.rows.filter((row) => row && typeof row === 'object').map((row) => ({ ...row }))
    : [];
  const columns = Array.isArray(spec.columns) && spec.columns.length
    ? spec.columns.map((column) => String(column))
    : inferColumns(rows);
  const filters = Array.isArray(spec.filters)
    ? spec.filters.map((filter) => ({
        label: String(filter?.label ?? filter?.field ?? 'Filter'),
        field: String(filter?.field ?? ''),
        type: filter?.type === 'text' ? 'text' : 'select',
        options: Array.isArray(filter?.options) ? filter.options.map((option) => String(option)) : [],
      })).filter((filter) => filter.field)
    : [];
  const metrics = Array.isArray(spec.metrics)
    ? spec.metrics.map((metric) => ({
        label: String(metric?.label ?? 'Metric'),
        value: metric?.value ?? '',
        detail: String(metric?.detail ?? ''),
      }))
    : [];

  return {
    title: String(spec.title ?? 'Workbook').trim() || 'Workbook',
    subtitle: String(spec.subtitle ?? spec.description ?? '').trim(),
    notes: String(spec.notes ?? '').trim(),
    searchPlaceholder: String(spec.searchPlaceholder ?? 'Search rows').trim() || 'Search rows',
    rows,
    columns,
    filters,
    metrics,
    chart: spec.chart && typeof spec.chart === 'object'
      ? {
          title: String(spec.chart.title ?? 'Breakdown').trim() || 'Breakdown',
          type: spec.chart.type === 'line' ? 'line' : 'bar',
          groupBy: String(spec.chart.groupBy ?? columns[0] ?? '').trim(),
          valueField: String(spec.chart.valueField ?? '').trim(),
        }
      : {
          title: 'Breakdown',
          type: 'bar',
          groupBy: String(columns[0] ?? '').trim(),
          valueField: '',
        },
  };
}

function workbookClientScript() {
  return [
    'const stateEl = document.getElementById("wmux-workbook-state");',
    'const workbook = JSON.parse(stateEl.textContent || "{}");',
    'const searchWrap = document.getElementById("workbook-search-wrap");',
    'const filtersHost = document.getElementById("workbook-filters");',
    'const metricsHost = document.getElementById("workbook-metrics");',
    'const chartHost = document.getElementById("workbook-chart");',
    'const tableHost = document.getElementById("workbook-table");',
    'const detailHost = document.getElementById("workbook-detail");',
    'const selectionHost = document.getElementById("workbook-selection");',
    'const chartTitleHost = document.getElementById("workbook-chart-title");',
    'const resultCountHost = document.getElementById("workbook-result-count");',
    'const resetButton = document.getElementById("workbook-reset");',
    'const state = { search: "", filters: Object.create(null), sortField: workbook.chart?.groupBy || workbook.columns[0] || "", sortDir: "desc", selectedGroup: null, selectedRowIndex: 0 };',
    'const formatValue = (value) => {',
    '  if (value === null || value === undefined || value === "") return "—";',
    '  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString();',
    '  if (value instanceof Date) return value.toLocaleString();',
    '  if (typeof value === "object") return JSON.stringify(value);',
    '  return String(value);',
    '};',
    'const getColumnLabel = (column) => String(column).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");',
    'const escapeText = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");',
    'const rows = () => Array.isArray(workbook.rows) ? workbook.rows : [];',
    'const visibleRows = () => {',
    '  const searchNeedle = state.search.trim().toLowerCase();',
    '  const filtered = rows().filter((row) => {',
    '    if (state.selectedGroup && workbook.chart?.groupBy) {',
    '      if (String(row[workbook.chart.groupBy] ?? "") !== state.selectedGroup) return false;',
    '    }',
    '    for (const filter of workbook.filters || []) {',
    '      const value = String(row[filter.field] ?? "");',
    '      const chosen = state.filters[filter.field] ?? "all";',
    '      if (chosen !== "all" && value !== chosen) return false;',
    '    }',
    '    if (!searchNeedle) return true;',
    '    return Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(searchNeedle));',
    '  });',
    '  filtered.sort((left, right) => {',
    '    const leftValue = left?.[state.sortField];',
    '    const rightValue = right?.[state.sortField];',
    '    if (typeof leftValue === "number" && typeof rightValue === "number") {',
    '      return state.sortDir === "asc" ? leftValue - rightValue : rightValue - leftValue;',
    '    }',
    '    return state.sortDir === "asc"',
    '      ? String(leftValue ?? "").localeCompare(String(rightValue ?? ""))',
    '      : String(rightValue ?? "").localeCompare(String(leftValue ?? ""));',
    '  });',
    '  return filtered;',
    '};',
    'const aggregateBy = (data, groupBy, valueField) => {',
    '  const totals = new Map();',
    '  for (const row of data) {',
    '    const key = String(row?.[groupBy] ?? "Unspecified");',
    '    const previous = totals.get(key) || { key, value: 0, count: 0 };',
    '    const raw = valueField ? Number(row?.[valueField]) : 1;',
    '    previous.value += Number.isFinite(raw) ? raw : 0;',
    '    previous.count += 1;',
    '    totals.set(key, previous);',
    '  }',
    '  return [...totals.values()].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));',
    '};',
    'const renderMetrics = (data) => {',
    '  const metrics = Array.isArray(workbook.metrics) && workbook.metrics.length',
    '    ? workbook.metrics',
    '    : [{ label: "Rows", value: data.length, detail: "filtered result count" }];',
    '  metricsHost.innerHTML = metrics.map((metric) => `<article class="workbook-metric"><div class="workbook-metric-label">${escapeText(metric.label)}</div><div class="workbook-metric-value">${formatValue(metric.value)}</div>${metric.detail ? `<div class="workbook-metric-detail">${escapeText(metric.detail)}</div>` : ""}</article>`).join("");',
    '};',
    'const renderFilters = () => {',
    '  const searchHtml = `<label class="workbook-filter workbook-filter-search"><span>Search</span><input id="workbook-search-input" type="search" placeholder="${escapeText(workbook.searchPlaceholder || "Search rows")}" value="${escapeText(state.search)}" spellcheck="false" /></label>`;',
    '  const filterHtml = (workbook.filters || []).map((filter) => {',
    '    const values = new Set(["all"]);',
    '    for (const row of rows()) {',
    '      const value = String(row?.[filter.field] ?? "").trim();',
    '      if (value) values.add(value);',
    '    }',
    '    const sourceValues = filter.options && filter.options.length ? filter.options : [...values];',
    '    const options = sourceValues.map((option) => {',
    '      const normalized = String(option);',
    '      const selected = (state.filters[filter.field] ?? "all") === normalized ? " selected" : "";',
    '      return `<option value="${escapeText(normalized)}"${selected}>${escapeText(normalized === "all" ? "All" : normalized)}</option>`;',
    '    }).join("");',
    '    return `<label class="workbook-filter"><span>${escapeText(filter.label)}</span><select data-filter-field="${escapeText(filter.field)}">${options}</select></label>`;',
    '  }).join("");',
    '  filtersHost.innerHTML = searchHtml + filterHtml;',
    '  const searchInput = document.getElementById("workbook-search-input");',
    '  if (searchInput) searchInput.addEventListener("input", (event) => { state.search = event.target.value; state.selectedRowIndex = 0; render(); });',
    '  filtersHost.querySelectorAll("select[data-filter-field]").forEach((select) => {',
    '    select.addEventListener("change", (event) => {',
    '      const field = event.currentTarget.dataset.filterField;',
    '      state.filters[field] = event.currentTarget.value;',
    '      state.selectedRowIndex = 0;',
    '      render();',
    '    });',
    '  });',
    '};',
    'const renderChart = (data) => {',
    '  const groupBy = workbook.chart?.groupBy || workbook.columns[0] || "";',
    '  const valueField = workbook.chart?.valueField || "";',
    '  const aggregates = aggregateBy(data, groupBy, valueField);',
    '  const maxValue = Math.max(1, ...aggregates.map((item) => item.value));',
    '  chartTitleHost.textContent = workbook.chart?.title || "Breakdown";',
    '  resultCountHost.textContent = `${data.length} matching rows`;',
    '  if (!aggregates.length) {',
    '    chartHost.innerHTML = `<div class="workbook-empty">No rows match the current filters.</div>`;',
    '    return;',
    '  }',
    '  chartHost.innerHTML = `<div class="workbook-bars">${aggregates.map((item) => {',
    '    const selected = state.selectedGroup === item.key ? " selected" : "";',
    '    const pct = Math.max(4, Math.round((item.value / maxValue) * 100));',
    '    return `<button class="workbook-bar${selected}" data-group="${escapeText(item.key)}"><span class="workbook-bar-label">${escapeText(item.key)}</span><span class="workbook-bar-track"><span class="workbook-bar-fill" style="width:${pct}%"></span></span><span class="workbook-bar-value">${formatValue(item.value)}</span></button>`;',
    '  }).join("")}</div>`;',
    '  chartHost.querySelectorAll("[data-group]").forEach((button) => {',
    '    button.addEventListener("click", (event) => {',
    '      const group = event.currentTarget.dataset.group;',
    '      state.selectedGroup = state.selectedGroup === group ? null : group;',
    '      state.selectedRowIndex = 0;',
    '      render();',
    '    });',
    '  });',
    '};',
    'const renderTable = (data) => {',
    '  const columns = Array.isArray(workbook.columns) && workbook.columns.length ? workbook.columns : Object.keys(data[0] || {});',
    '  const headerHtml = columns.map((column) => `<th><button class="workbook-th-btn${state.sortField === column ? " active" : ""}" data-sort-field="${escapeText(column)}">${escapeText(getColumnLabel(column))}${state.sortField === column ? (state.sortDir === "asc" ? " ▲" : " ▼") : ""}</button></th>`).join("");',
    '  const rowHtml = data.length ? data.map((row, index) => {',
    '    const selected = index === state.selectedRowIndex ? " selected" : "";',
    '    return `<tr class="${selected}" data-row-index="${index}">${columns.map((column) => `<td>${escapeText(formatValue(row?.[column]))}</td>`).join("")}</tr>`;',
    '  }).join("") : `<tr><td colspan="${Math.max(1, columns.length)}" class="workbook-empty-cell">No data after filtering.</td></tr>`;',
    '  tableHost.innerHTML = `<table class="workbook-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowHtml}</tbody></table>`;',
    '  tableHost.querySelectorAll("[data-sort-field]").forEach((button) => {',
    '    button.addEventListener("click", (event) => {',
    '      const field = event.currentTarget.dataset.sortField;',
    '      if (state.sortField === field) {',
    '        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";',
    '      } else {',
    '        state.sortField = field;',
    '        state.sortDir = "asc";',
    '      }',
    '      render();',
    '    });',
    '  });',
    '  tableHost.querySelectorAll("[data-row-index]").forEach((rowEl) => {',
    '    rowEl.addEventListener("click", (event) => {',
    '      state.selectedRowIndex = Number(event.currentTarget.dataset.rowIndex || 0);',
    '      render();',
    '    });',
    '  });',
    '};',
    'const renderDetail = (data) => {',
    '  const row = data[state.selectedRowIndex] || data[0];',
    '  if (!row) {',
    '    detailHost.innerHTML = `<div class="workbook-empty">Select a row to inspect its values.</div>`;',
    '    selectionHost.textContent = "No row selected";',
    '    return;',
    '  }',
    '  selectionHost.textContent = `Row ${state.selectedRowIndex + 1} of ${data.length}`;',
    '  detailHost.innerHTML = `<div class="workbook-detail-card">${Object.entries(row).map(([key, value]) => `<div class="workbook-detail-row"><span>${escapeText(getColumnLabel(key))}</span><strong>${escapeText(formatValue(value))}</strong></div>`).join("")}</div>`;',
    '};',
    'const render = () => {',
    '  const data = visibleRows();',
    '  renderFilters();',
    '  renderMetrics(data);',
    '  renderChart(data);',
    '  renderTable(data);',
    '  renderDetail(data);',
    '};',
    'resetButton.addEventListener("click", () => {',
    '  state.search = "";',
    '  state.filters = Object.create(null);',
    '  state.sortField = workbook.chart?.groupBy || workbook.columns[0] || "";',
    '  state.sortDir = "desc";',
    '  state.selectedGroup = null;',
    '  state.selectedRowIndex = 0;',
    '  render();',
    '});',
    'render();',
  ].join('\n');
}

export function buildWorkbookHtml(spec = {}) {
  const workbook = normalizeWorkbookSpec(spec);
  const subtitle = workbook.subtitle ? `<p class="workbook-subtitle">${escapeHtml(workbook.subtitle)}</p>` : '';
  const notes = workbook.notes ? `<section class="workbook-notes">${escapeHtml(workbook.notes)}</section>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(workbook.title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: rgba(15, 23, 42, 0.92);
      --panel-soft: rgba(15, 23, 42, 0.72);
      --border: rgba(148, 163, 184, 0.18);
      --border-strong: rgba(96, 165, 250, 0.32);
      --text: #e5eefb;
      --muted: #93a4bf;
      --accent: #60a5fa;
      --accent-2: #22c55e;
      --shadow: 0 24px 80px rgba(2, 8, 23, 0.45);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(96,165,250,0.18), transparent 34%),
        radial-gradient(circle at top right, rgba(34,197,94,0.14), transparent 30%),
        linear-gradient(180deg, #06101d 0%, #091523 100%);
      color: var(--text);
    }
    .workbook-shell {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
    }
    .workbook-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      margin-bottom: 20px;
    }
    .workbook-kicker {
      margin: 0 0 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--accent);
    }
    .workbook-title {
      margin: 0;
      font-size: clamp(28px, 4vw, 44px);
      line-height: 1.05;
      letter-spacing: -0.03em;
    }
    .workbook-subtitle {
      margin: 10px 0 0;
      max-width: 760px;
      color: var(--muted);
      line-height: 1.5;
    }
    .workbook-toolbar {
      min-width: min(100%, 560px);
      display: grid;
      grid-template-columns: 1.5fr repeat(auto-fit, minmax(160px, 1fr)) auto;
      gap: 10px;
      align-items: end;
    }
    .workbook-filter,
    .workbook-search-wrap {
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .workbook-filter input,
    .workbook-filter select,
    .workbook-search-wrap input {
      width: 100%;
      border: 1px solid var(--border);
      background: rgba(15, 23, 42, 0.88);
      color: var(--text);
      border-radius: 12px;
      padding: 11px 12px;
      outline: none;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
    }
    .workbook-reset {
      border: 1px solid var(--border-strong);
      background: linear-gradient(135deg, rgba(96,165,250,0.28), rgba(34,197,94,0.22));
      color: var(--text);
      border-radius: 12px;
      padding: 11px 14px;
      cursor: pointer;
      font-weight: 600;
      transition: transform 140ms ease, border-color 140ms ease;
    }
    .workbook-reset:hover { transform: translateY(-1px); border-color: rgba(96,165,250,0.6); }
    .workbook-metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin: 22px 0;
    }
    .workbook-metric,
    .workbook-panel,
    .workbook-notes {
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(15, 23, 42, 0.76));
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }
    .workbook-metric { padding: 18px; }
    .workbook-metric-label,
    .workbook-panel-kicker,
    .workbook-selection {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .workbook-metric-value {
      margin-top: 10px;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .workbook-metric-detail {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .workbook-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(300px, 0.8fr);
      gap: 16px;
      align-items: start;
    }
    .workbook-panel {
      padding: 18px;
      min-width: 0;
    }
    .workbook-panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      margin-bottom: 14px;
    }
    .workbook-panel-title {
      margin: 0;
      font-size: 18px;
      letter-spacing: -0.02em;
    }
    .workbook-panel-count { color: var(--muted); font-size: 13px; }
    .workbook-bars { display: grid; gap: 10px; }
    .workbook-bar {
      width: 100%;
      border: 1px solid transparent;
      background: rgba(15, 23, 42, 0.7);
      color: var(--text);
      border-radius: 14px;
      padding: 12px;
      display: grid;
      gap: 8px;
      cursor: pointer;
      text-align: left;
      transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
    }
    .workbook-bar:hover,
    .workbook-bar.selected {
      transform: translateY(-1px);
      border-color: rgba(96, 165, 250, 0.45);
      background: rgba(30, 41, 59, 0.92);
    }
    .workbook-bar-label,
    .workbook-bar-value { font-weight: 600; }
    .workbook-bar-track {
      display: block;
      height: 10px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.12);
      overflow: hidden;
    }
    .workbook-bar-fill {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, rgba(96, 165, 250, 0.95), rgba(34, 197, 94, 0.95));
    }
    .workbook-table-wrap {
      max-height: 620px;
      overflow: auto;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.14);
    }
    .workbook-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .workbook-table thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: rgba(15, 23, 42, 0.98);
      text-align: left;
      padding: 0;
    }
    .workbook-th-btn {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px 14px;
      border: 0;
      background: transparent;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      font-weight: 600;
    }
    .workbook-th-btn:hover,
    .workbook-th-btn.active { background: rgba(96, 165, 250, 0.14); }
    .workbook-table tbody tr { border-top: 1px solid rgba(148, 163, 184, 0.1); cursor: pointer; }
    .workbook-table tbody tr.selected { background: rgba(96, 165, 250, 0.14); }
    .workbook-table td { padding: 11px 14px; vertical-align: top; color: #dbe7f7; }
    .workbook-detail-card { display: grid; gap: 10px; }
    .workbook-detail-row {
      display: grid;
      gap: 4px;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(148, 163, 184, 0.12);
    }
    .workbook-detail-row span {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .workbook-detail-row strong {
      font-size: 14px;
      word-break: break-word;
      font-weight: 600;
    }
    .workbook-empty,
    .workbook-empty-cell {
      color: var(--muted);
      text-align: center;
      padding: 24px;
    }
    .workbook-notes {
      margin-top: 16px;
      padding: 14px 16px;
      color: var(--muted);
      line-height: 1.5;
    }
    @media (max-width: 1180px) {
      .workbook-header { flex-direction: column; }
      .workbook-toolbar { width: 100%; grid-template-columns: 1fr 1fr; }
      .workbook-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .workbook-shell { padding: 14px; }
      .workbook-toolbar { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="workbook-shell">
    <header class="workbook-header">
      <div>
        <div class="workbook-kicker">Interactive workbook</div>
        <h1 class="workbook-title">${escapeHtml(workbook.title)}</h1>
        ${subtitle}
      </div>
      <div class="workbook-toolbar">
        <label class="workbook-search-wrap" id="workbook-search-wrap">
          <span>Search</span>
          <input id="workbook-search" type="search" placeholder="${escapeHtml(workbook.searchPlaceholder)}" spellcheck="false" />
        </label>
        <div id="workbook-filters"></div>
        <button id="workbook-reset" class="workbook-reset">Reset filters</button>
      </div>
    </header>

    <section id="workbook-metrics" class="workbook-metrics"></section>

    <section class="workbook-grid">
      <section class="workbook-panel">
        <div class="workbook-panel-head">
          <div>
            <div class="workbook-panel-kicker">Chart</div>
            <h2 id="workbook-chart-title" class="workbook-panel-title"></h2>
          </div>
          <div id="workbook-result-count" class="workbook-panel-count"></div>
        </div>
        <div id="workbook-chart"></div>
      </section>

      <section class="workbook-panel">
        <div class="workbook-panel-head">
          <div>
            <div class="workbook-panel-kicker">Rows</div>
            <h2 class="workbook-panel-title">Table</h2>
          </div>
        </div>
        <div class="workbook-table-wrap" id="workbook-table"></div>
      </section>

      <aside class="workbook-panel">
        <div class="workbook-panel-head">
          <div>
            <div class="workbook-panel-kicker">Selection</div>
            <h2 class="workbook-panel-title">Row details</h2>
          </div>
          <div id="workbook-selection" class="workbook-selection"></div>
        </div>
        <div id="workbook-detail"></div>
      </aside>
    </section>

    ${notes}
  </main>
  <script id="wmux-workbook-state" type="application/json">${safeJsonForHtml(workbook)}</script>
  <script>
${workbookClientScript()}
  </script>
</body>
</html>`;
}

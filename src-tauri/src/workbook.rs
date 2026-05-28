use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;
use tokio::sync::Mutex as TokioMutex;

pub const WORKBOOK_ROUTE: &str = "/workbook";

// ---------------------------------------------------------------------------
// Live workbook state — ephemeral, in-memory only (not persisted to disk).
// Workbook pages POST their current UI state here after every render, and
// agents POST commands that the workbook page polls and applies.
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct WorkbookLiveState {
    inner: Arc<TokioMutex<WorkbookLiveInner>>,
}

#[derive(Default)]
struct WorkbookLiveInner {
    states: HashMap<String, Value>,
    commands: HashMap<String, Vec<Value>>,
}

impl WorkbookLiveState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn set_state(&self, id: &str, state: Value) {
        self.inner.lock().await.states.insert(id.to_string(), state);
    }

    pub async fn get_state(&self, id: &str) -> Option<Value> {
        self.inner.lock().await.states.get(id).cloned()
    }

    pub async fn push_command(&self, id: &str, command: Value) {
        self.inner.lock().await.commands.entry(id.to_string()).or_default().push(command);
    }

    pub async fn drain_commands(&self, id: &str) -> Vec<Value> {
        self.inner.lock().await.commands.remove(id).unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookSpec {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub rows: Vec<Value>,
    #[serde(default)]
    pub columns: Vec<WorkbookColumn>,
    #[serde(default)]
    pub metrics: Vec<WorkbookMetric>,
    #[serde(default)]
    pub filters: Vec<WorkbookFilter>,
    #[serde(default)]
    pub charts: Vec<WorkbookChart>,
    #[serde(default)]
    pub table: WorkbookTable,
    #[serde(default)]
    pub layout: WorkbookLayout,
    #[serde(default)]
    pub created_at_ms: u64,
    #[serde(default)]
    pub updated_at_ms: u64,
    /// Full HTML document the agent provides for complete creative control.
    /// When set the structured schema fields are ignored for rendering.
    #[serde(default)]
    pub html: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookColumn {
    pub key: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

// Accept either a plain string ("city") or a full object ({"key":"city","label":"City"}).
impl<'de> serde::Deserialize<'de> for WorkbookColumn {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(untagged, rename_all = "camelCase")]
        enum Raw {
            Str(String),
            Obj { key: String, #[serde(default)] label: Option<String>, #[serde(default)] kind: Option<String> },
        }
        match Raw::deserialize(d)? {
            Raw::Str(key) => Ok(Self { key, label: None, kind: None }),
            Raw::Obj { key, label, kind } => Ok(Self { key, label, kind }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookMetric {
    #[serde(default)]
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookFilter {
    #[serde(default)]
    pub id: String,
    pub label: String,
    pub field: String,
    #[serde(default = "default_filter_type")]
    pub kind: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookChart {
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default = "default_chart_kind")]
    pub kind: String,
    #[serde(default)]
    pub group_by: String,
    #[serde(default)]
    pub value_field: Option<String>,
    #[serde(default = "default_aggregation")]
    pub aggregation: String,
    #[serde(default = "default_sort")]
    pub sort: String,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub filters: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookTable {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub default_sort_field: Option<String>,
    #[serde(default = "default_sort")]
    pub default_sort_direction: String,
    #[serde(default = "default_page_size")]
    pub page_size: usize,
}

impl Default for WorkbookTable {
    fn default() -> Self {
        Self {
            enabled: true,
            default_sort_field: None,
            default_sort_direction: default_sort(),
            page_size: default_page_size(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookLayout {
    #[serde(default)]
    pub chart_order: Vec<String>,
    #[serde(default)]
    pub selected_chart_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookSummary {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub charts: usize,
    pub rows: usize,
    pub updated_at_ms: u64,
}

pub struct WorkbookStore {
    dir: PathBuf,
}

impl WorkbookStore {
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("workbooks");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self { dir })
    }

    fn path_for(&self, workbook_id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", workbook_id))
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn ensure_ids(spec: &mut WorkbookSpec) {
        if spec.id.trim().is_empty() {
            spec.id = format!("wbk-{}", uuid::Uuid::new_v4().simple());
        }
        if spec.title.trim().is_empty() {
            spec.title = "Workbook".to_string();
        }
        if spec.columns.is_empty() {
            spec.columns = infer_columns(&spec.rows);
        }
        if spec.metrics.is_empty() {
            spec.metrics.push(WorkbookMetric {
                id: "rows".to_string(),
                label: "Rows".to_string(),
                value: json!(spec.rows.len()),
                detail: Some("current row count".to_string()),
            });
        }
        for (idx, metric) in spec.metrics.iter_mut().enumerate() {
            if metric.id.trim().is_empty() {
                metric.id = format!("metric-{}", idx + 1);
            }
        }
        for (idx, filter) in spec.filters.iter_mut().enumerate() {
            if filter.id.trim().is_empty() {
                filter.id = format!("filter-{}", idx + 1);
            }
            if filter.kind.trim().is_empty() {
                filter.kind = default_filter_type();
            }
            if filter.options.is_empty() {
                filter.options = distinct_values(&spec.rows, &filter.field);
            }
        }
        for (idx, chart) in spec.charts.iter_mut().enumerate() {
            if chart.id.trim().is_empty() {
                chart.id = format!("chart-{}", idx + 1);
            }
            if chart.kind.trim().is_empty() {
                chart.kind = default_chart_kind();
            }
            if chart.aggregation.trim().is_empty() {
                chart.aggregation = default_aggregation();
            }
            if chart.sort.trim().is_empty() {
                chart.sort = default_sort();
            }
        }
        if spec.layout.chart_order.is_empty() {
            spec.layout.chart_order = spec.charts.iter().map(|chart| chart.id.clone()).collect();
        }
        if spec.layout.selected_chart_id.is_none() {
            spec.layout.selected_chart_id = spec.charts.first().map(|chart| chart.id.clone());
        }
        if spec.created_at_ms == 0 {
            spec.created_at_ms = Self::now_ms();
        }
        spec.updated_at_ms = Self::now_ms();
    }

    fn normalize_chart_mutation(spec: &mut WorkbookSpec) {
        Self::ensure_ids(spec);
        if spec.layout.chart_order.is_empty() {
            spec.layout.chart_order = spec.charts.iter().map(|chart| chart.id.clone()).collect();
        }
        if spec.layout.selected_chart_id.is_none() {
            spec.layout.selected_chart_id = spec.charts.first().map(|chart| chart.id.clone());
        }
    }

    pub fn upsert(&self, mut spec: WorkbookSpec) -> Result<WorkbookSpec, String> {
        Self::ensure_ids(&mut spec);
        let path = self.path_for(&spec.id);
        let json = serde_json::to_string_pretty(&spec).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())?;
        Ok(spec)
    }

    pub fn list(&self) -> Result<Vec<WorkbookSummary>, String> {
        let mut items = Vec::new();
        for entry in fs::read_dir(&self.dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let spec = match Self::read_spec(&path) {
                Ok(spec) => spec,
                Err(_) => continue,
            };
            items.push(WorkbookSummary {
                id: spec.id,
                title: spec.title,
                subtitle: spec.subtitle,
                charts: spec.charts.len(),
                rows: spec.rows.len(),
                updated_at_ms: spec.updated_at_ms,
            });
        }
        items.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms).then_with(|| a.title.cmp(&b.title)));
        Ok(items)
    }

    pub fn get(&self, workbook_id: &str) -> Result<WorkbookSpec, String> {
        Self::read_spec(&self.path_for(workbook_id))
    }

    pub fn delete(&self, workbook_id: &str) -> Result<(), String> {
        let path = self.path_for(workbook_id);
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn add_chart(&self, workbook_id: &str, mut chart: WorkbookChart) -> Result<WorkbookSpec, String> {
        let mut spec = self.get(workbook_id)?;
        if chart.id.trim().is_empty() {
            chart.id = format!("chart-{}", uuid::Uuid::new_v4().simple());
        }
        if chart.kind.trim().is_empty() {
            chart.kind = default_chart_kind();
        }
        if chart.aggregation.trim().is_empty() {
            chart.aggregation = default_aggregation();
        }
        if chart.sort.trim().is_empty() {
            chart.sort = default_sort();
        }
        spec.charts.push(chart);
        Self::normalize_chart_mutation(&mut spec);
        self.upsert(spec)
    }

    pub fn update_chart(&self, workbook_id: &str, chart: WorkbookChart) -> Result<WorkbookSpec, String> {
        let mut spec = self.get(workbook_id)?;
        let idx = spec
            .charts
            .iter()
            .position(|existing| existing.id == chart.id)
            .ok_or_else(|| format!("chart '{}' not found", chart.id))?;
        spec.charts[idx] = chart;
        Self::normalize_chart_mutation(&mut spec);
        self.upsert(spec)
    }

    pub fn remove_chart(&self, workbook_id: &str, chart_id: &str) -> Result<WorkbookSpec, String> {
        let mut spec = self.get(workbook_id)?;
        let before = spec.charts.len();
        spec.charts.retain(|chart| chart.id != chart_id);
        if spec.charts.len() == before {
            return Err(format!("chart '{}' not found", chart_id));
        }
        spec.layout.chart_order.retain(|id| id != chart_id);
        if spec.layout.selected_chart_id.as_deref() == Some(chart_id) {
            spec.layout.selected_chart_id = spec.charts.first().map(|chart| chart.id.clone());
        }
        Self::normalize_chart_mutation(&mut spec);
        self.upsert(spec)
    }

    pub fn reorder_charts(&self, workbook_id: &str, chart_ids: &[String]) -> Result<WorkbookSpec, String> {
        let mut spec = self.get(workbook_id)?;
        let mut ordered = Vec::new();
        for chart_id in chart_ids {
            if let Some(chart) = spec.charts.iter().find(|existing| &existing.id == chart_id) {
                if !ordered.iter().any(|existing: &WorkbookChart| existing.id == chart.id) {
                    ordered.push(chart.clone());
                }
            }
        }
        for chart in &spec.charts {
            if !ordered.iter().any(|existing: &WorkbookChart| existing.id == chart.id) {
                ordered.push(chart.clone());
            }
        }
        spec.charts = ordered;
        spec.layout.chart_order = chart_ids.to_vec();
        Self::normalize_chart_mutation(&mut spec);
        self.upsert(spec)
    }

    pub fn preview_url(api_base: &str, workbook_id: &str) -> String {
        format!("{}{WORKBOOK_ROUTE}?id={workbook_id}", api_base.trim_end_matches('/'))
    }

    fn read_spec(path: &Path) -> Result<WorkbookSpec, String> {
        let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let mut spec: WorkbookSpec = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        Self::ensure_ids(&mut spec);
        Ok(spec)
    }
}

pub fn render_workbook_html(spec: &WorkbookSpec) -> String {
    if spec.html.is_some() {
        return render_custom_workbook_html(spec);
    }
    let spec_json = escape_json_for_html(&serde_json::to_string(spec).unwrap_or_else(|_| "{}".to_string()));
    let title = escape_html(&spec.title);
    let subtitle = spec
        .subtitle
        .as_ref()
        .map(|value| format!("<p class=\"workbook-subtitle\">{}</p>", escape_html(value)))
        .unwrap_or_default();
    let description = spec
        .description
        .as_ref()
        .map(|value| format!("<section class=\"workbook-notes\">{}</section>", escape_html(value)))
        .unwrap_or_default();
    let template = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>__TITLE__</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #06101d;
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
    .workbook-shell { max-width: 1440px; margin: 0 auto; padding: 24px; }
    .workbook-header {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 20px;
    }
    .workbook-kicker {
      margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--accent);
    }
    .workbook-title { margin: 0; font-size: clamp(28px, 4vw, 44px); line-height: 1.05; letter-spacing: -0.03em; }
    .workbook-subtitle { margin: 10px 0 0; max-width: 760px; color: var(--muted); line-height: 1.5; }
    .workbook-toolbar {
      min-width: min(100%, 560px); display: grid; grid-template-columns: 1.5fr repeat(auto-fit, minmax(160px, 1fr)) auto; gap: 10px; align-items: end;
    }
    .workbook-filter, .workbook-search-wrap { display: grid; gap: 6px; font-size: 12px; color: var(--muted); }
    .workbook-filter input, .workbook-filter select, .workbook-search-wrap input {
      width: 100%; border: 1px solid var(--border); background: rgba(15, 23, 42, 0.88); color: var(--text); border-radius: 12px; padding: 11px 12px; outline: none;
    }
    .workbook-reset {
      border: 1px solid var(--border-strong); background: linear-gradient(135deg, rgba(96,165,250,0.28), rgba(34,197,94,0.22)); color: var(--text); border-radius: 12px; padding: 11px 14px; cursor: pointer; font-weight: 600;
    }
    .workbook-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin: 22px 0; }
    .workbook-metric, .workbook-panel, .workbook-notes {
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(15, 23, 42, 0.76)); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow); backdrop-filter: blur(18px);
    }
    .workbook-metric { padding: 18px; }
    .workbook-metric-label, .workbook-panel-kicker, .workbook-selection { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; }
    .workbook-metric-value { margin-top: 10px; font-size: 32px; font-weight: 700; letter-spacing: -0.03em; }
    .workbook-metric-detail { margin-top: 6px; color: var(--muted); font-size: 13px; }
    .workbook-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(300px, 0.8fr); gap: 16px; align-items: start; }
    .workbook-panel { padding: 18px; min-width: 0; }
    .workbook-panel-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 14px; }
    .workbook-panel-title { margin: 0; font-size: 18px; letter-spacing: -0.02em; }
    .workbook-panel-count { color: var(--muted); font-size: 13px; }
    .workbook-chart-nav { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .workbook-chart-nav button {
      border: 1px solid var(--border); background: rgba(15, 23, 42, 0.72); color: var(--text); border-radius: 999px; padding: 8px 12px; cursor: pointer; font-size: 12px;
    }
    .workbook-chart-nav button.active { border-color: var(--border-strong); background: rgba(96, 165, 250, 0.18); }
    .workbook-bars { display: grid; gap: 10px; }
    .workbook-bar {
      width: 100%; border: 1px solid transparent; background: rgba(15, 23, 42, 0.7); color: var(--text); border-radius: 14px; padding: 12px; display: grid; gap: 8px; cursor: pointer; text-align: left;
    }
    .workbook-bar.selected { border-color: rgba(96, 165, 250, 0.45); background: rgba(30, 41, 59, 0.92); }
    .workbook-bar-label, .workbook-bar-value { font-weight: 600; }
    .workbook-bar-track { display: block; height: 10px; border-radius: 999px; background: rgba(148, 163, 184, 0.12); overflow: hidden; }
    .workbook-bar-fill { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, rgba(96, 165, 250, 0.95), rgba(34, 197, 94, 0.95)); }
    .workbook-table-wrap { max-height: 620px; overflow: auto; border-radius: 14px; border: 1px solid rgba(148, 163, 184, 0.14); }
    .workbook-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .workbook-table thead th { position: sticky; top: 0; z-index: 1; background: rgba(15, 23, 42, 0.98); text-align: left; padding: 0; }
    .workbook-th-btn {
      width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border: 0; background: transparent; color: var(--text); cursor: pointer; font: inherit; font-weight: 600;
    }
    .workbook-th-btn:hover, .workbook-th-btn.active { background: rgba(96, 165, 250, 0.14); }
    .workbook-table tbody tr { border-top: 1px solid rgba(148, 163, 184, 0.1); cursor: pointer; }
    .workbook-table tbody tr.selected { background: rgba(96, 165, 250, 0.14); }
    .workbook-table td { padding: 11px 14px; vertical-align: top; color: #dbe7f7; }
    .workbook-detail-card { display: grid; gap: 10px; }
    .workbook-detail-row {
      display: grid; gap: 4px; padding: 10px 12px; border-radius: 12px; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(148, 163, 184, 0.12);
    }
    .workbook-detail-row span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .workbook-detail-row strong { font-size: 14px; word-break: break-word; font-weight: 600; }
    .workbook-empty, .workbook-empty-cell { color: var(--muted); text-align: center; padding: 24px; }
    .workbook-notes { margin-top: 16px; padding: 14px 16px; color: var(--muted); line-height: 1.5; }
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
        <h1 class="workbook-title">__TITLE__</h1>
        __SUBTITLE__
      </div>
      <div class="workbook-toolbar">
        <label class="workbook-search-wrap" id="workbook-search-wrap">
          <span>Search</span>
          <input id="workbook-search" type="search" placeholder="Search rows" spellcheck="false" />
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
            <div class="workbook-panel-kicker">Charts</div>
            <h2 id="workbook-chart-title" class="workbook-panel-title"></h2>
          </div>
          <div id="workbook-result-count" class="workbook-panel-count"></div>
        </div>
        <div id="workbook-chart-nav" class="workbook-chart-nav"></div>
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

    __DESCRIPTION__
  </main>
  <script id="wmux-workbook-state" type="application/json">__SPEC_JSON__</script>
  <script>__WB_SCRIPT__</script>
</body>
</html>"#;
    template
        .replace("__TITLE__", &title)
        .replace("__SUBTITLE__", &subtitle)
        .replace("__DESCRIPTION__", &description)
        .replace("__SPEC_JSON__", &spec_json)
        .replace("__WB_SCRIPT__", WORKBOOK_CLIENT_JS)
}

fn render_custom_workbook_html(spec: &WorkbookSpec) -> String {
    let html = spec.html.as_deref().unwrap_or("");
    let id_json = serde_json::to_string(&spec.id).unwrap_or_else(|_| r#""""#.to_string());
    let id_escaped = spec.id.replace('\'', "\\'");
    // Inject window.__wmux API so custom HTML can push state and receive commands.
    // Uses relative URLs — safe because this page is served from the same origin.
    let wmux_script = format!(
        r#"<script>window.__wmux={{workbookId:{id_json},setState:function(s){{return fetch('/workbook-state?id={id_escaped}',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(s)}}).catch(function(){{}});}},onCommand:function(cb){{var p=function(){{fetch('/workbook-command?id={id_escaped}').then(function(r){{return r.ok?r.json():[];}}).then(function(cs){{if(Array.isArray(cs))cs.forEach(cb);}}).catch(function(){{}}).finally(function(){{setTimeout(p,1500);}});}};setTimeout(p,1500);}}}};</script>"#
    );
    let lower = html.to_lowercase();
    if let Some(pos) = lower.find("</head>") {
        format!("{}{}{}", &html[..pos], wmux_script, &html[pos..])
    } else if let Some(pos) = lower.find("<body") {
        format!("{}{}{}", &html[..pos], wmux_script, &html[pos..])
    } else {
        format!("{wmux_script}{html}")
    }
}

const WORKBOOK_CLIENT_JS: &str = r##"
(() => {
  const stateEl = document.getElementById('wmux-workbook-state');
  const workbook = JSON.parse(stateEl.textContent || '{}');
  const state = {
    search: '',
    filters: Object.create(null),
    sortField: workbook.table?.defaultSortField || workbook.columns?.[0]?.key || '',
    sortDirection: workbook.table?.defaultSortDirection || 'desc',
    activeChartId: workbook.layout?.selectedChartId || workbook.charts?.[0]?.id || null,
    selectedGroup: null,
    selectedRowIndex: 0,
  };

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const formatValue = (value) => {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const rows = () => Array.isArray(workbook.rows) ? workbook.rows : [];
  const columns = () => Array.isArray(workbook.columns) && workbook.columns.length
    ? workbook.columns
    : Object.keys(rows()[0] || {}).map((key) => ({ key, label: key }));

  const activeChart = () => (workbook.charts || []).find((chart) => chart.id === state.activeChartId) || (workbook.charts || [])[0] || null;
  const columnLabel = (column) => String(column.label || column.key || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');

  const distinctValues = (field) => {
    const values = new Set();
    for (const row of rows()) {
      const value = String(row?.[field] ?? '').trim();
      if (value) values.add(value);
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  };

  const filteredRows = () => {
    const searchNeedle = state.search.trim().toLowerCase();
    const chart = activeChart();
    const data = rows().filter((row) => {
      if (state.selectedGroup && chart?.groupBy) {
        if (String(row?.[chart.groupBy] ?? '') !== state.selectedGroup) return false;
      }
      for (const filter of workbook.filters || []) {
        const selected = state.filters[filter.field] ?? 'all';
        if (selected !== 'all' && String(row?.[filter.field] ?? '') !== selected) return false;
      }
      if (!searchNeedle) return true;
      return Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(searchNeedle));
    });
    data.sort((left, right) => {
      const leftValue = left?.[state.sortField];
      const rightValue = right?.[state.sortField];
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return state.sortDirection === 'asc' ? leftValue - rightValue : rightValue - leftValue;
      }
      return state.sortDirection === 'asc'
        ? String(leftValue ?? '').localeCompare(String(rightValue ?? ''))
        : String(rightValue ?? '').localeCompare(String(leftValue ?? ''));
    });
    return data;
  };

  const aggregate = (chart, data) => {
    const bucket = new Map();
    if (!chart?.groupBy) return [];
    for (const row of data) {
      const key = String(row?.[chart.groupBy] ?? 'Unspecified');
      const current = bucket.get(key) || { key, value: 0, count: 0 };
      current.count += 1;
      if (chart.valueField && chart.aggregation !== 'count') {
        const raw = Number(row?.[chart.valueField]);
        current.value += Number.isFinite(raw) ? raw : 0;
      } else {
        current.value += 1;
      }
      bucket.set(key, current);
    }
    const items = [...bucket.values()];
    items.sort((a, b) => (chart.sort === 'asc' ? a.value - b.value : b.value - a.value) || a.key.localeCompare(b.key));
    return chart.limit ? items.slice(0, chart.limit) : items;
  };

  const renderMetrics = (data) => {
    const host = document.getElementById('workbook-metrics');
    const metrics = Array.isArray(workbook.metrics) && workbook.metrics.length
      ? workbook.metrics
      : [{ label: 'Rows', value: data.length, detail: 'filtered row count' }];
    host.innerHTML = metrics.map((metric) => `
      <article class="workbook-metric">
        <div class="workbook-metric-label">${escapeHtml(metric.label)}</div>
        <div class="workbook-metric-value">${formatValue(metric.value)}</div>
        ${metric.detail ? `<div class="workbook-metric-detail">${escapeHtml(metric.detail)}</div>` : ''}
      </article>
    `).join('');
  };

  const renderFilters = () => {
    const host = document.getElementById('workbook-filters');
    host.innerHTML = (workbook.filters || []).map((filter) => {
      const options = ['all', ...distinctValues(filter.field)];
      const selected = state.filters[filter.field] ?? 'all';
      return `
        <label class="workbook-filter">
          <span>${escapeHtml(filter.label)}</span>
          <select data-filter-field="${escapeHtml(filter.field)}">
            ${options.map((option) => `<option value="${escapeHtml(option)}"${option === selected ? ' selected' : ''}>${escapeHtml(option === 'all' ? 'All' : option)}</option>`).join('')}
          </select>
        </label>
      `;
    }).join('');
    host.querySelectorAll('select[data-filter-field]').forEach((select) => {
      select.addEventListener('change', (event) => {
        const field = event.currentTarget.dataset.filterField;
        state.filters[field] = event.currentTarget.value;
        state.selectedRowIndex = 0;
        render();
      });
    });
  };

  const renderChartNav = () => {
    const host = document.getElementById('workbook-chart-nav');
    const charts = Array.isArray(workbook.charts) ? workbook.charts : [];
    host.innerHTML = charts.map((chart) => `<button class="${chart.id === state.activeChartId ? 'active' : ''}" data-chart-id="${escapeHtml(chart.id)}">${escapeHtml(chart.title || chart.id || 'Chart')}</button>`).join('');
    host.querySelectorAll('[data-chart-id]').forEach((button) => {
      button.addEventListener('click', (event) => {
        state.activeChartId = event.currentTarget.dataset.chartId;
        state.selectedGroup = null;
        state.selectedRowIndex = 0;
        render();
      });
    });
  };

  const renderChart = (data) => {
    const host = document.getElementById('workbook-chart');
    const chart = activeChart();
    const titleHost = document.getElementById('workbook-chart-title');
    titleHost.textContent = chart?.title || 'Charts';
    document.getElementById('workbook-result-count').textContent = `${data.length} matching rows`;
    if (!chart) {
      host.innerHTML = '<div class="workbook-empty">No charts yet.</div>';
      return;
    }
    const items = aggregate(chart, data);
    if (!items.length) {
      host.innerHTML = '<div class="workbook-empty">No rows match the current filters.</div>';
      return;
    }
    const maxValue = Math.max(1, ...items.map((item) => item.value));
    host.innerHTML = `<div class="workbook-bars">${items.map((item) => {
      const selected = state.selectedGroup === item.key ? ' selected' : '';
      const width = Math.max(4, Math.round((item.value / maxValue) * 100));
      return `
        <button class="workbook-bar${selected}" data-group="${escapeHtml(item.key)}">
          <span class="workbook-bar-label">${escapeHtml(item.key)}</span>
          <span class="workbook-bar-track"><span class="workbook-bar-fill" style="width:${width}%"></span></span>
          <span class="workbook-bar-value">${formatValue(item.value)}</span>
        </button>
      `;
    }).join('')}</div>`;
    host.querySelectorAll('[data-group]').forEach((button) => {
      button.addEventListener('click', (event) => {
        const group = event.currentTarget.dataset.group;
        state.selectedGroup = state.selectedGroup === group ? null : group;
        state.selectedRowIndex = 0;
        render();
      });
    });
  };

  const renderTable = (data) => {
    const host = document.getElementById('workbook-table');
    const cols = columns();
    const header = cols.map((column) => `<th><button class="workbook-th-btn${state.sortField === column.key ? ' active' : ''}" data-sort-field="${escapeHtml(column.key)}">${escapeHtml(columnLabel(column))}${state.sortField === column.key ? (state.sortDirection === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`).join('');
    const body = data.length
      ? data.map((row, index) => `<tr class="${index === state.selectedRowIndex ? 'selected' : ''}" data-row-index="${index}">${cols.map((column) => `<td>${escapeHtml(formatValue(row?.[column.key]))}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${Math.max(1, cols.length)}" class="workbook-empty-cell">No data after filtering.</td></tr>`;
    host.innerHTML = `<table class="workbook-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
    host.querySelectorAll('[data-sort-field]').forEach((button) => {
      button.addEventListener('click', (event) => {
        const field = event.currentTarget.dataset.sortField;
        if (state.sortField === field) {
          state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortField = field;
          state.sortDirection = 'asc';
        }
        render();
      });
    });
    host.querySelectorAll('[data-row-index]').forEach((rowEl) => {
      rowEl.addEventListener('click', (event) => {
        state.selectedRowIndex = Number(event.currentTarget.dataset.rowIndex || 0);
        render();
      });
    });
  };

  const renderDetail = (data) => {
    const host = document.getElementById('workbook-detail');
    const row = data[state.selectedRowIndex] || data[0];
    if (!row) {
      host.innerHTML = '<div class="workbook-empty">Select a row to inspect its values.</div>';
      document.getElementById('workbook-selection').textContent = 'No row selected';
      return;
    }
    document.getElementById('workbook-selection').textContent = `Row ${state.selectedRowIndex + 1} of ${data.length}`;
    host.innerHTML = `<div class="workbook-detail-card">${Object.entries(row).map(([key, value]) => `<div class="workbook-detail-row"><span>${escapeHtml(key)}</span><strong>${escapeHtml(formatValue(value))}</strong></div>`).join('')}</div>`;
  };

  const pushState = (data) => {
    if (!workbook.id) return;
    fetch('/workbook-state?id=' + encodeURIComponent(workbook.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search: state.search,
        activeFilters: Object.assign({}, state.filters),
        selectedGroup: state.selectedGroup,
        selectedRowIndex: state.selectedRowIndex,
        activeChartId: state.activeChartId,
        visibleRowCount: data ? data.length : 0,
        selectedRow: data ? (data[state.selectedRowIndex] ?? null) : null,
      }),
    }).catch(() => {});
  };

  const applyCommand = (cmd) => {
    if (!cmd || !cmd.type) return;
    switch (cmd.type) {
      case 'set_filter':
        if (cmd.field) state.filters[cmd.field] = cmd.value !== undefined ? cmd.value : 'all';
        state.selectedRowIndex = 0;
        render();
        break;
      case 'set_search': {
        state.search = cmd.value !== undefined ? String(cmd.value) : '';
        state.selectedRowIndex = 0;
        const el = document.getElementById('workbook-search');
        if (el) el.value = state.search;
        render();
        break;
      }
      case 'select_row':
        if (typeof cmd.index === 'number') { state.selectedRowIndex = cmd.index; render(); }
        break;
      case 'select_chart':
        if (cmd.chartId) {
          state.activeChartId = cmd.chartId;
          state.selectedGroup = null;
          state.selectedRowIndex = 0;
          render();
        }
        break;
      case 'select_group':
        state.selectedGroup = cmd.group !== undefined ? cmd.group : null;
        state.selectedRowIndex = 0;
        render();
        break;
      case 'reset':
        state.search = '';
        state.filters = Object.create(null);
        state.sortField = workbook.table?.defaultSortField || workbook.columns?.[0]?.key || '';
        state.sortDirection = workbook.table?.defaultSortDirection || 'desc';
        state.activeChartId = workbook.layout?.selectedChartId || workbook.charts?.[0]?.id || null;
        state.selectedGroup = null;
        state.selectedRowIndex = 0;
        render();
        break;
    }
  };

  const pollCommands = () => {
    if (!workbook.id) return;
    fetch('/workbook-command?id=' + encodeURIComponent(workbook.id))
      .then((r) => r.ok ? r.json() : [])
      .then((cmds) => { if (Array.isArray(cmds)) cmds.forEach(applyCommand); })
      .catch(() => {})
      .finally(() => { setTimeout(pollCommands, 1500); });
  };

  const render = () => {
    const data = filteredRows();
    renderMetrics(data);
    renderFilters();
    renderChartNav();
    renderChart(data);
    renderTable(data);
    renderDetail(data);
    pushState(data);
  };

  document.getElementById('workbook-search').addEventListener('input', (event) => {
    state.search = event.target.value;
    state.selectedRowIndex = 0;
    render();
  });

  document.getElementById('workbook-reset').addEventListener('click', () => {
    state.search = '';
    state.filters = Object.create(null);
    state.sortField = workbook.table?.defaultSortField || workbook.columns?.[0]?.key || '';
    state.sortDirection = workbook.table?.defaultSortDirection || 'desc';
    state.activeChartId = workbook.layout?.selectedChartId || workbook.charts?.[0]?.id || null;
    state.selectedGroup = null;
    state.selectedRowIndex = 0;
    render();
  });

  render();
  setTimeout(pollCommands, 1500);
})();
"##;

fn default_filter_type() -> String { "select".to_string() }
fn default_chart_kind() -> String { "bar".to_string() }
fn default_aggregation() -> String { "sum".to_string() }
fn default_sort() -> String { "desc".to_string() }
fn default_page_size() -> usize { 50 }
fn default_true() -> bool { true }

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn escape_json_for_html(json: &str) -> String {
    json.replace('<', "\\u003c").replace("-->", "--\\>")
}

fn infer_columns(rows: &[Value]) -> Vec<WorkbookColumn> {
    let mut columns = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if let Some(obj) = row.as_object() {
            for key in obj.keys() {
                if seen.insert(key.clone()) {
                    columns.push(WorkbookColumn {
                        key: key.clone(),
                        label: Some(humanize_key(key)),
                        kind: None,
                    });
                }
            }
        }
    }
    columns
}

fn distinct_values(rows: &[Value], field: &str) -> Vec<String> {
    let mut values = std::collections::BTreeSet::new();
    for row in rows {
        if let Some(value) = row.get(field) {
            let text = value
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| value.to_string());
            if !text.trim().is_empty() {
                values.insert(text);
            }
        }
    }
    values.into_iter().collect()
}

fn humanize_key(key: &str) -> String {
  let mut out = String::new();
  let mut prev_is_space = true;
  for ch in key.replace(['_', '-'], " ").chars() {
    if ch.is_uppercase() && !prev_is_space {
      out.push(' ');
    }
    if out.is_empty() {
      out.extend(ch.to_uppercase());
    } else {
      out.push(ch);
    }
    prev_is_space = ch.is_whitespace();
  }
  out.split_whitespace()
    .map(|part| {
      let mut chars = part.chars();
      match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
      }
    })
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

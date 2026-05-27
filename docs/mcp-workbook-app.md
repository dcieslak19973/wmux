# Workbook MCP App

This document describes the workbook app shape for wmux: a persistent, agent-editable dashboard surface backed by MCP tools and rendered as an interactive local page.

## How to use it

1. Start wmux.
2. Click the `MCP` toolbar button in a pane and run the pasted `claude mcp add --transport http wmux http://localhost:7766/mcp` command once in Claude Code.
3. Ask Claude to create or update a workbook with `workbook_create`, `workbook_add_chart`, and `workbook_open`.
4. Open the returned `preview_url` in wmux, or use the `WKB` toolbar button to bring up the demo workbook surface.
5. Keep iterating with `workbook_update`, `workbook_update_chart`, `workbook_remove_chart`, and `workbook_reorder_charts`.
6. Read live UI state with `workbook_get_state`, or drive the pane with `workbook_send_command`.

Example prompt for Claude:

> Create a workbook named `Engineering Activity` with 2 charts, open it, then add a third chart and reorder the charts so the most important one is first.

## Summary

- App name: `workbook`
- Resource type: `workbooks/{id}`
- Persistence: JSON documents saved in the wmux app data directory
- Preview path: `GET /workbook?id={id}`
- Data model: workbook owns rows, columns, filters, metrics, charts, and layout
- Rendering: wmux loads the preview URL in an embedded browser pane
- State loop: workbook page POSTs live UI state to `POST /workbook-state?id={id}` after every render; agent reads it via `workbook_get_state`
- Command loop: agent POSTs commands via `workbook_send_command`; page polls `GET /workbook-command?id={id}` every 1.5 s and applies them

## Rendering modes

### Structured (default)

Use `rows`, `columns`, `metrics`, `charts`, and `filters`. Renders as the standard dark-theme table + bar-chart + detail-panel layout. Good for data exploration.

### Custom HTML

Set the `html` field to a complete HTML/CSS/JS document. wmux serves it directly with `window.__wmux` injected, giving agents full creative control: timelines, heatmaps, network graphs, annotated prose, canvas animations — anything.

```js
// Available in custom HTML after wmux injects the bootstrap script:
window.__wmux.workbookId           // string — the workbook id
window.__wmux.setState(stateObj)   // POST current UI state; agent reads via workbook_get_state
window.__wmux.onCommand(callback)  // polls for agent commands; callback(cmd) on each one
```

Example custom workbook:
```json
{
  "title": "Network Graph",
  "html": "<!doctype html><html>...<script>window.__wmux.onCommand(cmd => { /* respond to agent */ });</script></html>"
}
```

## Workbook resource

```json
{
  "id": "wbk_123",
  "title": "Engineering Activity",
  "subtitle": "Last 3 months",
  "description": "Interactive workbook for repo activity",
  "rows": [],
  "columns": [],
  "filters": [],
  "metrics": [],
  "charts": [],
  "html": null,
  "table": {
    "enabled": true,
    "defaultSortField": "pullRequests",
    "defaultSortDirection": "desc",
    "pageSize": 50
  },
  "layout": {
    "chartOrder": ["chart_1", "chart_2"],
    "selectedChartId": "chart_1"
  }
}
```

## Chart resource

Charts are first-class children of a workbook. A workbook can contain multiple charts, and Claude can add, remove, and reorder them over time.

```json
{
  "id": "chart_1",
  "title": "Pull requests by repository",
  "kind": "bar",
  "groupBy": "repository",
  "valueField": "pullRequests",
  "aggregation": "sum",
  "sort": "desc",
  "limit": 10,
  "filters": ["filter_owner"],
  "note": "Optional chart-specific guidance"
}
```

## Live state

The workbook page publishes its current UI state after every render. Shape for structured workbooks:

```json
{
  "search": "query string or empty",
  "activeFilters": { "fieldName": "selectedValue" },
  "selectedGroup": "bar label or null",
  "selectedRowIndex": 0,
  "activeChartId": "chart-1",
  "visibleRowCount": 42,
  "selectedRow": { "repository": "wmux", "pullRequests": 5 }
}
```

For custom HTML workbooks, shape is whatever the agent calls `window.__wmux.setState(obj)` with.

## Commands

Agents push commands via `workbook_send_command`. The workbook page polls every 1.5 s and applies them.

| `type` | Required fields | Effect |
|--------|----------------|--------|
| `set_filter` | `field`, `value` | Apply a filter (use `"all"` to clear) |
| `set_search` | `value` | Set the search query |
| `select_row` | `index` | Select a table row by index |
| `select_chart` | `chartId` | Switch the active chart |
| `select_group` | `group` | Select a chart bar group (null to clear) |
| `reset` | — | Clear all filters and selection |

For custom HTML workbooks, the command object is forwarded as-is to the `onCommand` callback.

## MCP tools

### `workbook_list`
List saved workbook summaries.

### `workbook_get`
Fetch a saved workbook by id.

### `workbook_create`
Create and persist a new workbook. Supports structured (`rows`, `charts`, etc.) or custom (`html`) rendering mode.

### `workbook_update`
Replace an existing workbook spec by id.

### `workbook_delete`
Delete a workbook.

### `workbook_open`
Open a workbook as a live browser pane inside wmux. Always call after `workbook_create` to make the workbook visible.

### `workbook_add_chart`
Append a chart to a workbook's charts array.

### `workbook_update_chart`
Replace a chart inside a workbook by chart id.

### `workbook_remove_chart`
Remove a chart from a workbook by chart id.

### `workbook_reorder_charts`
Set the display order of charts.

### `workbook_get_state`
Read the current live UI state of an open workbook pane. Returns `null` if the workbook has not published state yet (not yet opened in a browser pane).

Input:
```json
{ "workbook_id": "wbk_123" }
```

### `workbook_send_command`
Drive a live workbook pane. The page applies the command within ~1.5 s.

Input:
```json
{
  "workbook_id": "wbk_123",
  "command": { "type": "set_filter", "field": "repository", "value": "wmux" }
}
```

## Lifecycle

1. Claude creates a workbook with rows and one or more charts (or custom HTML).
2. wmux persists the workbook and returns a preview URL.
3. wmux renders the workbook in an embedded browser pane.
4. The workbook page begins publishing live UI state to `workbook_get_state`.
5. Claude reads state, drives the pane with `workbook_send_command`, or updates the spec.
6. wmux keeps the workbook state on disk so the same app can be reopened later.

## Recommended agent prompt

Ask the agent to:

- For data exploration: produce a workbook JSON object with rows, metrics, and at least one chart
- For creative/custom surfaces: set the `html` field to a complete document; use `window.__wmux.setState()` to publish meaningful state and `window.__wmux.onCommand()` to accept agent commands
- Call `workbook_open` after creation to make it visible
- Call `workbook_get_state` to read what the user is currently looking at before adding commentary or pivoting the analysis
- Use `workbook_send_command` to guide the user's attention to specific data points

## Implementation notes

- Workbooks are stored as JSON under the wmux app data directory.
- Preview pages are served locally and loaded in the embedded browser.
- Live state and commands are in-memory only — not persisted across app restarts.
- `window.__wmux` is injected into custom HTML pages automatically by the renderer.

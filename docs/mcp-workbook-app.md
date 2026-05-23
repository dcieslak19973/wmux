# Workbook MCP App

This document describes the workbook app shape for wmux: a persistent, agent-editable dashboard surface backed by MCP tools and rendered as an interactive local page.

## How to use it

1. Start wmux.
2. Click the `MCP` toolbar button in a pane and run the pasted `claude mcp add --transport http wmux http://localhost:7766/mcp` command once in Claude Code.
3. Ask Claude to create or update a workbook with `workbook_create`, `workbook_add_chart`, and `workbook_open`.
4. Open the returned `preview_url` in wmux, or use the `WKB` toolbar button to bring up the demo workbook surface.
5. Keep iterating with `workbook_update`, `workbook_update_chart`, `workbook_remove_chart`, and `workbook_reorder_charts`.

Example prompt for Claude:

> Create a workbook named `Engineering Activity` with 2 charts, open it, then add a third chart and reorder the charts so the most important one is first.

## Summary

- App name: `workbook`
- Resource type: `workbooks/{id}`
- Persistence: JSON documents saved in the wmux app data directory
- Preview path: `GET /workbook?id={id}`
- Data model: workbook owns rows, columns, filters, metrics, charts, and layout
- Rendering: wmux loads the preview URL in an embedded browser pane

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

## MCP tools

### `workbook_list`
List saved workbook summaries.

Returns:
- `id`
- `title`
- `subtitle`
- `charts`
- `rows`
- `updatedAtMs`

### `workbook_get`
Fetch a saved workbook by id.

Input:
```json
{ "workbook_id": "wbk_123" }
```

### `workbook_create`
Create and persist a new workbook.

Input:
```json
{
  "workbook": {
    "title": "Engineering Activity",
    "rows": [],
    "charts": []
  }
}
```

Returns:
- `workbook`
- `preview_url`

### `workbook_update`
Replace an existing workbook by id.

Input:
```json
{
  "workbook": {
    "id": "wbk_123",
    "title": "Engineering Activity v2"
  }
}
```

### `workbook_delete`
Delete a workbook.

Input:
```json
{ "workbook_id": "wbk_123" }
```

### `workbook_open`
Open a workbook for preview.

Input variants:
```json
{ "workbook_id": "wbk_123" }
```

or

```json
{ "workbook": { "title": "..." } }
```

Returns:
- `workbook`
- `preview_url`

### `workbook_add_chart`
Append a chart to a workbook.

Input:
```json
{
  "workbook_id": "wbk_123",
  "chart": {
    "title": "Issues by owner",
    "kind": "bar",
    "groupBy": "owner",
    "valueField": "issues"
  }
}
```

### `workbook_update_chart`
Replace a chart inside a workbook by chart id.

Input:
```json
{
  "workbook_id": "wbk_123",
  "chart": {
    "id": "chart_1",
    "title": "Pull requests by repository"
  }
}
```

### `workbook_remove_chart`
Remove a chart from a workbook by chart id.

Input:
```json
{
  "workbook_id": "wbk_123",
  "chart_id": "chart_1"
}
```

### `workbook_reorder_charts`
Set the display order of charts.

Input:
```json
{
  "workbook_id": "wbk_123",
  "chart_ids": ["chart_2", "chart_1"]
}
```

## Lifecycle

1. Claude creates a workbook with rows and one or more charts.
2. wmux persists the workbook and returns a preview URL.
3. wmux renders the workbook in an embedded browser pane.
4. Claude adds or removes charts as the analysis evolves.
5. wmux keeps the workbook state on disk so the same app can be reopened later.

## Recommended agent prompt

Ask the agent to:

- produce a workbook JSON object rather than a static image
- include at least one metric and one chart
- include chart ids so charts can be updated later
- prefer multiple charts when the data supports multiple views
- reopen the same workbook after each mutation to verify the result

## Implementation notes

- Workbooks are stored as JSON under the wmux app data directory.
- Preview pages are served locally and loaded in the embedded browser.
- The app surface is stateful, so it can be iterated on instead of regenerated from scratch.


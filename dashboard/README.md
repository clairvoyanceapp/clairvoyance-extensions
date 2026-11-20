# Dashboard Extension

A simple extension that adds a Dashboard tab showing recent notes, reports, canvases, and exhibits.

## Purpose

This is the **test extension** for validating the Clairvoyance extension system. It demonstrates:

- Tab-only extension (no sidebar, just opens a tab directly)
- Command Bar icon integration
- Extension asset loading via `extension-assets://{id}/...`
- Theme variable injection
- Host bridge RPC for fetching content

## How It Works

1. User clicks the Dashboard icon in the Command Bar
2. A Dashboard tab opens in the main content area
3. The tab displays a grid of recent content:
   - Recent Notes
   - Recent Reports  
   - Recent Canvases
   - Recent Exhibits

Each section shows items with title, workspace name, and relative update time.
"View all" buttons navigate to the corresponding sidebar.

## Extension Schema

This extension uses the `clairvoyance-extension` type with the `contributes` pattern:

```yaml
extension:
  type: clairvoyance-extension
  contributes:
    commandBar:
      title: Dashboard
      icon: icon.svg
    tabs:
      - id: main
        title: Dashboard
        entrypoint: dashboard.html
        singleton: true
```

Since there's no `sidebar` contribution and only one tab, clicking the Command Bar icon
opens the tab directly.

## Required Extension Bridge APIs

### `dashboard.getSummary()`

```typescript
dashboard.getSummary(input: { limit: number }): Promise<{
  recent: {
    notes: Array<{ id: string; title: string; workspaceName?: string; updatedAt: number }>;
    reports: Array<{ id: string; title: string; workspaceName?: string; updatedAt: number }>;
    canvases: Array<{ id: string; title: string; workspaceName?: string; updatedAt: number }>;
    exhibits: Array<{ id: string; title: string; workspaceName?: string; updatedAt: number }>;
  };
}>
```

### `ui.navigate()`

```typescript
ui.navigate(target: { 
  kind: 'sidebar'; 
  mode: 'notes' | 'reports' | 'canvas' | 'exhibits' 
}): Promise<void>
```

### `ui.openContent()`

```typescript
ui.openContent(target: { 
  type: 'note' | 'report' | 'canvas' | 'exhibit'; 
  id: string 
}): Promise<void>
```

## Permissions

- `workspace-read` — Access current workspace info
- `notes-read` — List recent notes
- `canvas-read` — List recent canvases
- `exhibits-read` — List recent exhibits

## Files

| File | Description |
|------|-------------|
| `extension.yaml` | Extension manifest |
| `dashboard.html` | Tab UI entrypoint |
| `dashboard.css` | Styles (uses Clairvoyance CSS variables) |
| `dashboard.js` | Runtime logic |
| `icon.svg` | 22×22 monochrome Command Bar icon |

## Packaging

To create a `.cvextension` package:

```bash
cd Docs/Design/Extensions/test-dashboard-extension
zip -r ../dashboard-0.1.0.cvextension extension.yaml dashboard.html dashboard.css dashboard.js icon.svg
```

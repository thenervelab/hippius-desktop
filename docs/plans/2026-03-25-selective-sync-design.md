# Selective Sync — Desktop Integration Design

**Date:** 2026-03-25
**Status:** Approved
**hcfs-client PR:** #48 (selective-sync, merged at 822513d)
**hcfs-client rev:** d792381 (already includes PR #48)

## Summary

Expose hcfs-client's file/directory exclusion API through Tauri IPC commands and add a per-drive exclusion patterns UI in the frontend settings.

## Background

PR #48 added glob-based file/directory exclusion to hcfs-client. Patterns are stored in `.hippius/{label}/exclude` (one per line, gitignore-style). The desktop backend already loads `ExcludeRules` during `scan_local_files` and `build_path_index`, so exclusion works silently. What's missing is the user-facing management layer.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI location | Per-drive settings | Patterns are per-drive in hcfs-client; keeps config close to the drive it affects |
| Excluded count in sync progress | Silent (no display) | Exclusion is set-and-forget; showing counts every cycle is noise |
| Pattern input | Free-text glob | Maps 1:1 to `.hippius/exclude` format; simple to implement |
| Sync trigger on pattern change | None (next cycle) | Simplest, no surprise bandwidth; user can manually sync |

## Backend — Tauri IPC Commands

New file: `src-tauri/src/commands/selective_sync.rs`

### `list_exclude_patterns(label: String) -> Vec<String>`

- `try_lock()` on the drive mutex for `label`
- If locked, fall back to reading `{config_dir}/exclude` directly (plain text, safe for concurrent reads)
- If drive not initialized, return empty `Vec`

### `add_exclude_pattern(label: String, pattern: String) -> bool`

- Validate: reject empty, whitespace-only, or patterns containing `../`
- Acquire drive lock, call `drive.add_exclude_pattern(&pattern)`
- If drive not initialized, write directly to `{config_dir}/exclude`
- Returns `true` if added, `false` if already present

### `remove_exclude_pattern(label: String, pattern: String) -> bool`

- Acquire drive lock, call `drive.remove_exclude_pattern(&pattern)`
- If drive not initialized, edit `{config_dir}/exclude` directly
- Returns `true` if removed, `false` if not found

### `is_file_excluded(label: String, path: String, is_dir: bool) -> bool`

- Acquire drive lock, call `drive.is_excluded(Path::new(&path), is_dir)`
- Useful for frontend to check exclusion status of visible files

All commands: `#[tauri::command]`, access `AppState` via `tauri::State`, get drive from `SyncEngine`. Registered in `main.rs` `generate_handler![]`.

## Frontend — ExclusionPatterns Component

New file: `app/components/sync/ExclusionPatterns.tsx`

Props: `label: string`

### Layout

```
+---------------------------------------------+
| > Exclusion Patterns                        |
| +------------------------------------------+|
| | [___________________] [Add]              ||
| |                                          ||
| |  *.tmp                              [x]  ||
| |  node_modules/                      [x]  ||
| |  .DS_Store                          [x]  ||
| |                                          ||
| |  Empty: "All files are synced"           ||
| +------------------------------------------+|
+---------------------------------------------+
```

### Behavior

- Collapsible section within per-drive settings
- On expand: `invoke("list_exclude_patterns", { label })` populates list
- Text input + Add button (or Enter). Calls `invoke("add_exclude_pattern", { label, pattern })`
- If `add_exclude_pattern` returns `false`: inline hint "Pattern already exists"
- Each row has x button: `invoke("remove_exclude_pattern", { label, pattern })`
- Helper text below input: "Use trailing `/` for directories (e.g. `node_modules/`)"
- Empty state: "All files are synced"

### Integration

Embed `<ExclusionPatterns label={driveLabel} />` in the existing drive settings component.

## Edge Cases

### Drive lock contention

`list_exclude_patterns` uses `try_lock()` with fallback to direct file read. The `.hippius/exclude` file is a plain text file; hcfs-client writes atomically, so concurrent reads are safe.

### Drive not initialized

When no drive exists for the label (user opens settings before first sync):
- `list_exclude_patterns` returns empty Vec
- `add/remove` operate directly on `{config_dir}/exclude` file
- Patterns load automatically when drive initializes

### Input validation

- Reject empty or whitespace-only patterns
- Reject patterns with `../` (path traversal)
- Trim whitespace before passing to API

## What We're NOT Building

- No sync plan callback changes (exclusion is silent)
- No file browser right-click to exclude
- No preset pattern suggestions
- No immediate sync trigger on pattern change
- No database schema changes (patterns live in `.hippius/exclude`)

## File Changes

| File | Change |
|------|--------|
| `src-tauri/src/commands/selective_sync.rs` | New — 4 IPC commands |
| `src-tauri/src/commands/mod.rs` | Add `pub mod selective_sync;` |
| `src-tauri/src/main.rs` | Register 4 commands in `generate_handler![]` |
| `app/components/sync/ExclusionPatterns.tsx` | New — pattern management UI |
| Existing drive settings component | Embed `<ExclusionPatterns />` |

## Testing

### Rust

- Round-trip: add pattern, list (contains it), remove, list (gone)
- Validation: empty pattern rejected, `../` rejected, whitespace trimmed
- Drive-not-initialized fallback: direct file read/write works
- Lock contention: `try_lock` fallback reads file correctly

### Frontend

- Component renders empty state
- Add pattern appears in list
- Remove pattern disappears from list
- Duplicate pattern shows hint
- Helper text visible

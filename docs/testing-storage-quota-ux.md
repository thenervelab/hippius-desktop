# Testing storage / quota upload gates (dev only)

Use this when checking Subscribe vs Upgrade UX for no-plan and over-quota
accounts without juggling many real wallets.

## Run the app

```bash
cd hippius-desktop
pnpm tauri:dev
```

Sign in as usual. In a development build a small **Dev: storage overview**
panel appears at the bottom-left of every signed-in page. Production /
`next build` builds never mount it (`NODE_ENV === "development"` only).

## Scenarios

| Panel option | What it simulates | Expected UI |
|---|---|---|
| Live overview | Real `get_storage_overview` | Whatever the signed-in account is |
| No plan (access-key) | `source: none` | Danger banner + 30-day deletion copy. File / Folder / Sync **disabled**. Drop → Subscribe dialog (same 30-day copy). Context menu upload items disabled. |
| Free under 10 GB | OAuth free with room | Uploads work normally |
| Free over 10 GB | Free overage | Warning banner: uploads paused, files stay. Buttons/menus disabled. Drop → Upgrade dialog. |
| Paid under limit | Active subscription with room | Uploads work |
| Paid over limit | Paid overage | Same as free-over, paid wording |

## Manual checks per blocked scenario

1. Toolbar File / Folder / Sync look disabled and do **not** open a dialog on click.
2. Drag a file onto Drive → subscribe/upgrade dialog, no picker / no upload start.
3. Right-click background → Upload File / Upload Folder / Sync a Folder are disabled; New Folder still works.
4. Empty-state / Overview banners match the dialog body (no-plan mentions 30 days; over-quota does not).

## Real accounts (optional)

- Access-key / mnemonic with no subscription → live `none` (no need for the panel).
- Google/GitHub free under or over 10 GB → live free.
- Paid plan under or over → live subscription.

Prefer the panel when iterating on copy or disable behavior so you do not flip billing on staging.

// The Insights sheet's query keys, in a module of their own so a row's
// Insights button can read what the sheet already loaded without importing
// the sheet.

export const insightsQueryKey = (shareToken: string) => ["share-insights", shareToken] as const;
export const commentsQueryKey = (shareToken: string) => ["share-comments", shareToken] as const;
export const reactionsQueryKey = (shareToken: string) => ["share-reactions", shareToken] as const;
export const linkSettingsQueryKey = (shareToken: string) => ["share-link-settings", shareToken] as const;

/**
 * How the panel's reads and changes run. Each is an IPC call that Rust
 * answers even offline (saying why), so they must not wait for the network
 * the way TanStack's default does: offline, a paused read held the skeleton
 * forever and never reached the "You're offline" line. One try: the line
 * says what went wrong, and Try again is right beside it.
 */
export const PANEL_QUERY = { retry: false, networkMode: "always" } as const;
export const PANEL_MUTATION = { networkMode: "always" } as const;

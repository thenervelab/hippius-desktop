// The Insights sheet's query keys, in a module of their own so a row's
// Insights button can read what the sheet already loaded without importing
// the sheet.

export const insightsQueryKey = (shareToken: string) => ["share-insights", shareToken] as const;
export const commentsQueryKey = (shareToken: string) => ["share-comments", shareToken] as const;
export const reactionsQueryKey = (shareToken: string) => ["share-reactions", shareToken] as const;
export const linkSettingsQueryKey = (shareToken: string) => ["share-link-settings", shareToken] as const;

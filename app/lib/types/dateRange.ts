/**
 * Inclusive date window used by the files page Date filter and any
 * cross-folder search call. Both fields are `YYYY-MM-DD` strings
 * (treated as UTC dates by the Rust filter chain). Same shape as the
 * web console's `DateRange` so payloads pass through unchanged when
 * the hooks lift filter state into IPC arguments.
 */
export interface DateRange {
    from: string;
    to: string;
}

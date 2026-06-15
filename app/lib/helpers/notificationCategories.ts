/**
 * Human-facing display name for a notification category.
 *
 * The stored category *key* — the Rust preference `label` and the matching
 * `notification_type` on each row (e.g. `"Files"`) — is also the key the
 * visibility filter matches on (`buildNotificationView`), so it must NOT be
 * renamed at the data layer. Display names are pure presentation and live here.
 *
 * `"Files"` is surfaced to users as `"Drive"`. Centralising this keeps the
 * settings dialog, the settings page, and the bell/page category filters showing
 * one consistent name instead of the earlier mix of "Files" and "Storage".
 */
const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  Files: "Drive",
};

/** Display name for a category key; the key itself is returned when unmapped. */
export function notificationCategoryLabel(category: string): string {
  return CATEGORY_DISPLAY_NAMES[category] ?? category;
}

// Coarse "in 4d" / "12m ago" / "<1m" formatter for RFC 3339 timestamps.
//
// Returns the original string if unparseable so a wire-format change
// upstream doesn't blank a row. Shared by the /shares page and the
// shared-link badge tooltip so both surfaces agree on phrasing.

export function formatRelative(rfc3339: string): string {
  const ms = Date.parse(rfc3339);
  if (Number.isNaN(ms)) return rfc3339;
  const diffMs = ms - Date.now();
  const abs = Math.abs(diffMs);
  const future = diffMs > 0;
  if (abs < 60_000) return future ? "in <1m" : "<1m ago";
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}

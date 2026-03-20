const ELLIPSIS = "\u2026"; // …

/**
 * Middle-truncate a string: keeps ~60% from start and ~40% from end,
 * inserting a single ellipsis character in the center.
 * Returns the original string unchanged if it fits within maxChars.
 */
export function middleTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const available = maxChars - 1; // 1 char for ellipsis
  const startLen = Math.ceil(available * 0.6);
  const endLen = available - startLen;
  return text.slice(0, startLen) + ELLIPSIS + text.slice(-endLen);
}

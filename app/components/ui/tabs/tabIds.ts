/** The ids a tab and its panel point at each other with (`aria-controls`, `aria-labelledby`). */
export function tabIds(base: string, key: string) {
  return { tab: `${base}-tab-${key}`, panel: `${base}-panel-${key}` };
}

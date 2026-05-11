/**
 * Compare two file/folder names using macOS Finder ordering rules
 * (equivalent to NSString.localizedStandardCompare):
 *   1. Case-insensitive
 *   2. Natural number ordering  ("9" < "10", "2025" < "2026")
 *   3. Category order: punctuation/symbols < digits < letters
 *
 * Mirrors the `macos_name_cmp` Rust function in sync/files.rs so that
 * clicking the NAME column header gives the same order as the default load.
 */
export function macosNameCmp(a: string, b: string): number {
  const norm = (s: string): string =>
    s
      .split("")
      .map((c) => {
        if (/\d/.test(c)) return c;
        const lo = c.toLowerCase();
        return /[a-z]/.test(lo) ? lo : "\x01";
      })
      .join("");

  const na = norm(a);
  const nb = norm(b);

  let i = 0;
  let j = 0;

  while (i < na.length && j < nb.length) {
    const ca = na[i];
    const cb = nb[j];

    if (/\d/.test(ca) && /\d/.test(cb)) {
      let numA = "";
      let numB = "";
      while (i < na.length && /\d/.test(na[i])) numA += na[i++];
      while (j < nb.length && /\d/.test(nb[j])) numB += nb[j++];
      const diff = parseInt(numA, 10) - parseInt(numB, 10);
      if (diff !== 0) return diff;
    } else {
      if (ca < cb) return -1;
      if (ca > cb) return 1;
      i++;
      j++;
    }
  }

  return na.length - nb.length;
}

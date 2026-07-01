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
  // Normalize per code point: digits as-is, cased letters lowercased to their
  // first lowercase char, everything else to '\x01' (sorts before digits and
  // letters). Mirrors Rust `normalize_char`.
  const normalize = (s: string): string[] => {
    const out: string[] = [];
    for (const c of s) {
      if (c >= "0" && c <= "9") {
        out.push(c);
        continue;
      }
      const first = [...c.toLowerCase()][0] ?? c;
      out.push(/\p{L}/u.test(first) ? first : "\x01");
    }
    return out;
  };

  const isDigit = (c: string | undefined): boolean =>
    c !== undefined && c >= "0" && c <= "9";

  const na = normalize(a);
  const nb = normalize(b);
  let i = 0;
  let j = 0;

  for (;;) {
    const ac = na[i];
    const bc = nb[j];
    if (ac === undefined && bc === undefined) return 0;
    if (ac === undefined) return -1;
    if (bc === undefined) return 1;

    if (isDigit(ac) && isDigit(bc)) {
      // Compare digit runs as SEQUENCES, not via parseInt: a 20+ digit filename
      // overflows Number and would collapse distinct runs to a tie (a non-total
      // order). Skip leading zeros so "007" == "7"; then a remaining digit in
      // one run means it is the longer — hence numerically larger — number, and
      // for equal lengths the first differing digit decides. Mirrors Rust
      // `macos_name_cmp`'s sequence comparison.
      while (na[i] === "0") i++;
      while (nb[j] === "0") j++;
      let runOrder = 0;
      for (;;) {
        const da = isDigit(na[i]) ? na[i] : undefined;
        const db = isDigit(nb[j]) ? nb[j] : undefined;
        if (da !== undefined && db !== undefined) {
          i++;
          j++;
          if (runOrder === 0) runOrder = da < db ? -1 : da > db ? 1 : 0;
        } else if (da !== undefined) {
          return 1;
        } else if (db !== undefined) {
          return -1;
        } else {
          break;
        }
      }
      if (runOrder !== 0) return runOrder;
    } else {
      if (ac < bc) return -1;
      if (ac > bc) return 1;
      i++;
      j++;
    }
  }
}

/**
 * Convert a scientific-notation number string (e.g. `"1.23e+5"`) to the
 * equivalent plain-decimal string (`"123000"`). Pure string manipulation
 * — no `Number` conversion, so values above `2^53` survive intact.
 *
 * Used at the indexer-response boundary when we receive a file-size
 * string in scientific notation and need to keep full precision before
 * handing it to downstream chart/formatter code.
 *
 * Non-scientific inputs are returned unchanged.
 */
export function sciToFullString(input: string): string {
  const s = input.trim();
  const sciRe = /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)[eE][+-]?\d+$/;
  if (!sciRe.test(s)) return input;

  const sign = s.startsWith("-") ? "-" : "";
  const body = s.replace(/^[+-]/, "");
  const [coeff, expStr] = body.split(/[eE]/);
  const exp = parseInt(expStr, 10);

  const [intPart, fracPart = ""] = coeff.split(".");
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "") || "0";
  const fracLen = fracPart.length;

  if (exp >= 0) {
    if (exp >= fracLen) {
      const zeros = "0".repeat(exp - fracLen);
      const out = (digits + zeros).replace(/^0+(?=\d)/, "") || "0";
      return sign + out;
    }
    const pos = intPart.length + exp;
    const merged = intPart + fracPart;
    const before = merged.slice(0, pos).replace(/^0+(?=\d)/, "") || "0";
    const after = merged.slice(pos);
    return sign + before + "." + after;
  }
  const abs = Math.abs(exp);
  const merged = intPart + fracPart;
  if (abs >= intPart.length) {
    const zeros = "0".repeat(abs - intPart.length);
    const tail = merged.replace(/^0+/, "") || "0";
    return sign + "0." + zeros + tail;
  }
  const pos = intPart.length - abs;
  const before = intPart.slice(0, pos).replace(/^0+(?=\d)/, "") || "0";
  const after = intPart.slice(pos) + fracPart;
  return sign + before + "." + after;
}

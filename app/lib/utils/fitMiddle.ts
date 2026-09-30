/**
 * Shorten an identity (an address, a name, an email) in the MIDDLE so it
 * fits a width in pixels. Pure: the caller hands in how to measure a string,
 * so the component measures with the element's real font and the tests with
 * a fixed width per character.
 *
 * Why not CSS `truncate`: it cuts the END, which is the part that tells two
 * addresses apart and the part of an email that says where it lives. And a
 * string already shortened by a character count and then cut again by CSS
 * showed two ellipses ("5DSQAMf3JVb3V…5…"). Here one pass decides, from the
 * real width, where the single "…" goes.
 */

export const ELLIPSIS = "…"; // …

/** How to shorten: where the cut may land. */
export type IdentityKind = "email" | "address" | "name";

/** Width of `text` in pixels. */
export type MeasureText = (text: string) => number;

/** SS58 alphabet (base58) at the lengths Substrate addresses take. */
const SS58 = /^[1-9A-HJ-NP-Za-km-z]{40,50}$/;

/** What kind of identity a string is, so it can be cut in the right place. */
export function identityKind(text: string): IdentityKind {
  const at = text.lastIndexOf("@");
  // A host with a dot after the "@": "a@b.co". A GitHub "@handle" has none.
  if (at > 0 && text.indexOf(".", at + 2) > at + 1) return "email";
  if (SS58.test(text)) return "address";
  return "name";
}

/**
 * The longest `head…tail` (then `after`) of `text` that fits, keeping `n`
 * characters of it split by `headShare`, `n` at least `minKept`. Null when
 * nothing fits.
 */
function fitPlain(
  text: string,
  maxWidth: number,
  measure: MeasureText,
  headShare: number,
  after = "",
  minKept = 2,
): string | null {
  const build = (n: number) => {
    // Both sides keep at least one character once there are two to keep.
    const head = n < 2 ? n : Math.min(n - 1, Math.max(1, Math.ceil(n * headShare)));
    const tail = n - head;
    return text.slice(0, head) + ELLIPSIS + (tail > 0 ? text.slice(-tail) : "") + after;
  };
  // Widths grow with `n`, so the longest fit is a binary search away.
  let lo = minKept;
  let hi = text.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = build(mid);
    if (measure(candidate) <= maxWidth) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Fit `text` into `maxWidth` pixels, shortening only in the middle.
 *
 * - Anything that fits is returned as it is.
 * - An address keeps as much of its start and end as fits, split evenly, so
 *   with room for a dozen characters it shows at least the first six and the
 *   last six. It only goes below that when the column is narrower still.
 * - An email keeps the whole "@domain" and shortens the part before it
 *   ("julien.du…ois@starkleytech.com"). Only when not even one character of
 *   that part fits beside the domain is the domain itself cut, in the middle
 *   of the whole address, so its ending still shows.
 * - A name is cut in the middle, a little more of its start kept than its end.
 *
 * Never returns more than one "…". When not even "a…z" fits, that is returned
 * anyway and the container clips it.
 */
export function fitMiddle(
  text: string,
  maxWidth: number,
  measure: MeasureText,
  kind: IdentityKind = identityKind(text),
): string {
  if (text.length <= 2 || measure(text) <= maxWidth) return text;

  if (kind === "email") {
    const at = text.lastIndexOf("@");
    const local = text.slice(0, at);
    const domain = text.slice(at);
    if (local.length > 1) {
      // Down to one character before the "…@domain" before the domain gives.
      const fitted = fitPlain(local, maxWidth, measure, 0.6, domain, 1);
      if (fitted) return fitted;
    }
    return fitPlain(text, maxWidth, measure, 0.5) ?? shortest(text);
  }

  const headShare = kind === "address" ? 0.5 : 0.6;
  return fitPlain(text, maxWidth, measure, headShare) ?? shortest(text);
}

function shortest(text: string): string {
  return text.charAt(0) + ELLIPSIS + text.charAt(text.length - 1);
}

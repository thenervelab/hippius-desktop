import { describe, expect, it } from "vitest";
import { ELLIPSIS, fitMiddle, identityKind } from "../fitMiddle";

// Every character, the ellipsis included, is 8px wide, so a width in
// characters is `n * 8`.
const measure = (text: string) => [...text].length * 8;
const chars = (n: number) => n * 8;

const SS58 = "5DSQAMf3JVb3VqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqK7x5Wd";
const EMAIL = "julien.du.bois@starkleytech.com";

const ellipses = (text: string) => text.split(ELLIPSIS).length - 1;

describe("identityKind", () => {
  it("reads an email, an address and a name apart", () => {
    expect(identityKind(EMAIL)).toBe("email");
    expect(identityKind(SS58)).toBe("address");
    expect(identityKind("Julien Du Bois")).toBe("name");
  });

  it("does not take a handle or a bare @ for an email", () => {
    expect(identityKind("@ahmad_rao")).toBe("name");
    expect(identityKind("a@.com")).toBe("name");
  });
});

describe("fitMiddle", () => {
  it("leaves text that fits untouched", () => {
    expect(fitMiddle("Ada", chars(10), measure)).toBe("Ada");
    expect(fitMiddle(EMAIL, chars(EMAIL.length), measure)).toBe(EMAIL);
    expect(fitMiddle(SS58, chars(SS58.length), measure)).toBe(SS58);
  });

  it("keeps an email's whole domain and cuts the part before it in the middle", () => {
    const out = fitMiddle(EMAIL, chars(24), measure);
    expect(out.endsWith("@starkleytech.com")).toBe(true);
    expect(out.startsWith("j")).toBe(true);
    expect(ellipses(out)).toBe(1);
    expect(measure(out)).toBeLessThanOrEqual(chars(24));
    // The cut is inside the local part, with some of its end kept too.
    const [head, rest] = out.split(ELLIPSIS);
    expect("julien.du.bois".startsWith(head)).toBe(true);
    expect(rest.length).toBeGreaterThan("@starkleytech.com".length);
  });

  it("uses all the room it has for the email", () => {
    const out = fitMiddle(EMAIL, chars(28), measure);
    expect(measure(out)).toBe(chars(28));
  });

  it("only cuts into the domain when not one letter of the name fits beside it", () => {
    // "j…@starkleytech.com" is 19 characters: at 19 the domain survives...
    expect(fitMiddle(EMAIL, chars(19), measure)).toBe(`j${ELLIPSIS}@starkleytech.com`);
    // ...at 12 it cannot, so the whole address is cut in its middle and
    // still ends on the top-level domain.
    const narrow = fitMiddle(EMAIL, chars(12), measure);
    expect(measure(narrow)).toBeLessThanOrEqual(chars(12));
    expect(narrow.endsWith(".com")).toBe(true);
    expect(narrow.startsWith("julie")).toBe(true);
    expect(ellipses(narrow)).toBe(1);
  });

  it("keeps an address's first six and last six once there is room for them", () => {
    const out = fitMiddle(SS58, chars(13), measure);
    expect(out).toBe(`${SS58.slice(0, 6)}${ELLIPSIS}${SS58.slice(-6)}`);
    const wider = fitMiddle(SS58, chars(25), measure);
    expect(wider.startsWith(SS58.slice(0, 12))).toBe(true);
    expect(wider.endsWith(SS58.slice(-12))).toBe(true);
    expect(ellipses(wider)).toBe(1);
  });

  it("cuts a name in the middle, keeping a little more of its start", () => {
    const out = fitMiddle("Maximilian Alexander Oberhauser", chars(16), measure);
    expect(out).toBe(`Maximilia${ELLIPSIS}hauser`);
  });

  it("still fits a very narrow width, and never shows more than one ellipsis", () => {
    for (const text of [SS58, EMAIL, "Maximilian Alexander Oberhauser"]) {
      for (const width of [3, 4, 5, 8]) {
        const out = fitMiddle(text, chars(width), measure);
        expect(measure(out)).toBeLessThanOrEqual(chars(width));
        expect(ellipses(out)).toBe(1);
        // Both ends stay: the start and the very last character.
        expect(out.charAt(0)).toBe(text.charAt(0));
        expect(out.at(-1)).toBe(text.at(-1));
      }
    }
  });

  it("returns the shortest form when even that does not fit, for the box to clip", () => {
    expect(fitMiddle(SS58, 1, measure)).toBe(`5${ELLIPSIS}d`);
    expect(fitMiddle("ab", 1, measure)).toBe("ab");
  });
});

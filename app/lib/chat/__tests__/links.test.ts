import { describe, expect, it } from "vitest";

import { parseMatrixLink, parseMatrixToLink, parseMatrixUri } from "@/lib/chat/links";
import { eventPermalink } from "@/lib/chat/rooms";

describe("parseMatrixToLink", () => {
  it("reads the app's own percent-encoded permalinks back", () => {
    // `eventPermalink` encodes both segments; the link must round-trip or
    // "Copy link" produces something the app itself cannot follow.
    expect(parseMatrixToLink(eventPermalink("!abc:hippius.com", "$ev/en+t"))).toEqual({
      kind: "event",
      roomId: "!abc:hippius.com",
      eventId: "$ev/en+t",
    });
    expect(parseMatrixToLink("https://matrix.to/#/%40bob%3Ahippius.com")).toEqual({
      kind: "user",
      userId: "@bob:hippius.com",
    });
    expect(parseMatrixToLink("https://matrix.to/#/%23general%3Ahippius.com?via=hippius.com")).toEqual({
      kind: "room",
      roomId: "#general:hippius.com",
    });
  });

  it("reads raw links from other clients the same way", () => {
    expect(parseMatrixToLink("https://matrix.to/#/@bob:hippius.com")).toEqual({ kind: "user", userId: "@bob:hippius.com" });
    expect(parseMatrixToLink("https://matrix.to/#/!abc:hippius.com/$evt?via=hippius.com&via=other.org")).toEqual({
      kind: "event",
      roomId: "!abc:hippius.com",
      eventId: "$evt",
    });
    expect(parseMatrixToLink("https://matrix.to/#/#general:hippius.com/$evt")).toEqual({
      kind: "event",
      roomId: "#general:hippius.com",
      eventId: "$evt",
    });
    expect(parseMatrixToLink("HTTPS://MATRIX.TO/#/!abc:hippius.com")).toEqual({ kind: "room", roomId: "!abc:hippius.com" });
  });

  it("does not read anything else as a matrix.to link", () => {
    expect(parseMatrixToLink("https://hippius.com/#/@bob:hippius.com")).toBeNull();
    expect(parseMatrixToLink("https://matrix.to/#/")).toBeNull();
    expect(parseMatrixToLink("https://matrix.to/#/bob")).toBeNull();
    expect(parseMatrixToLink("https://matrix.to/#/@bob:hippius.com/$evt")).toBeNull();
    expect(parseMatrixToLink("https://matrix.to/#/!abc:hippius.com/not-an-event")).toBeNull();
    expect(parseMatrixToLink("https://matrix.to/#/!abc:hippius.com/$evt/extra")).toBeNull();
    // Malformed encoding fails the parse instead of being read raw.
    expect(parseMatrixToLink("https://matrix.to/#/%E0%A4%A")).toBeNull();
    // A `matrix:` URI is not a matrix.to link; `parseMatrixUri` reads it.
    expect(parseMatrixToLink("matrix:u/bob:hippius.com")).toBeNull();
  });
});

// The sanitiser passes `matrix:` hrefs through as internal navigation (no
// `target="_blank"`), so if the click handler did not route them the webview
// would navigate the app window to the URI — the same failure as an
// unmatched matrix.to link, in the other spelling.
describe("parseMatrixUri", () => {
  it("reads MSC2312 user, room, alias and event URIs", () => {
    expect(parseMatrixUri("matrix:u/bob:hippius.com")).toEqual({ kind: "user", userId: "@bob:hippius.com" });
    expect(parseMatrixUri("matrix:r/general:hippius.com")).toEqual({ kind: "room", roomId: "#general:hippius.com" });
    expect(parseMatrixUri("matrix:roomid/abc:hippius.com?via=hippius.com")).toEqual({ kind: "room", roomId: "!abc:hippius.com" });
    expect(parseMatrixUri("matrix:roomid/abc:hippius.com/e/evt?via=hippius.com")).toEqual({
      kind: "event",
      roomId: "!abc:hippius.com",
      eventId: "$evt",
    });
    expect(parseMatrixUri("matrix:r/general:hippius.com/e/evt")).toEqual({
      kind: "event",
      roomId: "#general:hippius.com",
      eventId: "$evt",
    });
  });

  it("percent-decodes ids and tolerates an authority and upper-case types", () => {
    expect(parseMatrixUri("matrix:U/bob%3Ahippius.com")).toEqual({ kind: "user", userId: "@bob:hippius.com" });
    expect(parseMatrixUri("matrix://hippius.com/roomid/abc%3Ahippius.com/e/ev%2Fent")).toEqual({
      kind: "event",
      roomId: "!abc:hippius.com",
      eventId: "$ev/ent",
    });
  });

  it("does not read anything else as a matrix: URI", () => {
    expect(parseMatrixUri("matrix:")).toBeNull();
    expect(parseMatrixUri("matrix:u")).toBeNull();
    expect(parseMatrixUri("matrix:x/bob:hippius.com")).toBeNull();
    expect(parseMatrixUri("matrix:e/evt")).toBeNull(); // an event without a room
    expect(parseMatrixUri("matrix:u/bob:hippius.com/e/evt")).toBeNull();
    expect(parseMatrixUri("matrix:roomid/abc:hippius.com/u/bob:hippius.com")).toBeNull();
    expect(parseMatrixUri("matrix:roomid/abc:hippius.com/e/evt/extra")).toBeNull();
    expect(parseMatrixUri("matrix:u/%E0%A4%A")).toBeNull();
    expect(parseMatrixUri("https://matrix.to/#/@bob:hippius.com")).toBeNull();
    expect(parseMatrixUri("mailto:bob@hippius.com")).toBeNull();
  });
});

describe("parseMatrixLink", () => {
  it("routes both spellings of the same target identically, and nothing else", () => {
    const viaMatrixTo = parseMatrixLink("https://matrix.to/#/!abc%3Ahippius.com/%24evt");
    const viaUri = parseMatrixLink("matrix:roomid/abc:hippius.com/e/evt");
    expect(viaMatrixTo).toEqual({ kind: "event", roomId: "!abc:hippius.com", eventId: "$evt" });
    expect(viaUri).toEqual(viaMatrixTo);
    expect(parseMatrixLink("https://hippius.com/")).toBeNull();
  });
});

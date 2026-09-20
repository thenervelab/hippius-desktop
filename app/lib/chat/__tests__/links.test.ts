import { describe, expect, it } from "vitest";

import { parseMatrixToLink } from "@/lib/chat/links";
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
    expect(parseMatrixToLink("matrix:u/bob:hippius.com")).toBeNull();
  });
});

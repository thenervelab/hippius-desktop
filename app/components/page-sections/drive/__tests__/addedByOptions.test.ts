import { describe, it, expect } from "vitest";

import { buildUploaderOptions } from "../AddedByFilter";

const ME = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const MEMBER = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";
const NAMELESS = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";

describe("Added by options", () => {
  it("names people like the column: the owner as name (owner), members by name", () => {
    const options = buildUploaderOptions({
      sessionSs58: ME,
      ownerSs58: OWNER,
      ownerName: "Grace",
      members: [
        { memberSs58: MEMBER, memberName: "Ada Lovelace" },
        { memberSs58: NAMELESS },
      ],
    });
    expect(options.map((o) => o.label)).toEqual([
      "You",
      "Grace (owner)",
      "Ada Lovelace",
      expect.stringContaining("…"),
      "Not recorded (shown as Owner)",
    ]);
    expect(options[1]).toMatchObject({ ss58: OWNER, name: "Grace", suffix: " (owner)" });
    // No name: a shortened address, never a blank or a placeholder email.
    expect(options[3].label.startsWith(NAMELESS.slice(0, 4))).toBe(true);
    expect(options[3].name).toBeUndefined();
  });

  it("an owner with no name known still reads as the owner", () => {
    const [, owner] = buildUploaderOptions({ sessionSs58: ME, ownerSs58: OWNER, members: [] });
    expect(owner.label.endsWith(" (owner)")).toBe(true);
    expect(owner.label.startsWith(OWNER.slice(0, 4))).toBe(true);
  });

  it("lists one person once, even under another address prefix", () => {
    const options = buildUploaderOptions({
      sessionSs58: ME,
      ownerSs58: ME,
      members: [{ memberSs58: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5", memberName: "Me again" }],
    });
    expect(options.map((o) => o.label)).toEqual(["You", "Not recorded (shown as Owner)"]);
  });
});

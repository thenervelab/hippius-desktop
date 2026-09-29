import { describe, expect, it } from "vitest";

import { inviteDriveDisplayName } from "../inviteDriveName";

describe("inviteDriveDisplayName", () => {
  it("keeps a human basename", () => {
    expect(inviteDriveDisplayName("team-docs", "team-docs")).toBe("team-docs");
  });

  it("never surfaces a shared: wire label", () => {
    const wire =
      "shared:5HHap2Pe2LaxxXp8Abcdefghijklmnop~263bad4ad83e395a";
    expect(inviteDriveDisplayName(wire, wire)).toBe("this drive");
    expect(inviteDriveDisplayName(wire, "team-docs")).toBe("team-docs");
  });

  it("falls back to label when folderName is the wire id", () => {
    const wire =
      "shared:5HHap2Pe2LaxxXp8Abcdefghijklmnop~263bad4ad83e395a";
    expect(inviteDriveDisplayName(wire, "Design Work")).toBe("Design Work");
  });
});

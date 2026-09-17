import { describe, expect, it } from "vitest";

import {
  driveRowSharing,
  rolesByLocalLabel,
} from "@/app/lib/shared-drives/driveRowSharing";

const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("driveRowSharing", () => {
  // An own drive has both identity columns NULL by construction.
  it("says nothing about an own drive", () => {
    expect(driveRowSharing({})).toEqual({
      isShared: false,
      roleLabel: null,
      title: null,
    });
    expect(driveRowSharing({ ownerSs58: null }).isShared).toBe(false);
    expect(driveRowSharing({ ownerSs58: "" }).isShared).toBe(false);
  });

  it("marks a drive owned by another account, naming the owner in the tooltip", () => {
    const sharing = driveRowSharing({ ownerSs58: OWNER, role: "writer" });
    expect(sharing.isShared).toBe(true);
    expect(sharing.roleLabel).toBe("Editor");
    expect(sharing.title).toContain(OWNER);
  });

  // Rows and roles come from different sources, so a row can render before its
  // role has arrived. Guessing one is worse than showing none: "Viewer" on a
  // drive the user can write to actively misleads.
  it("shows the badge without a role when the role has not arrived", () => {
    const sharing = driveRowSharing({ ownerSs58: OWNER });
    expect(sharing.isShared).toBe(true);
    expect(sharing.roleLabel).toBeNull();
  });

  it("degrades an unknown role to the least privileged label", () => {
    expect(driveRowSharing({ ownerSs58: OWNER, role: "admin" }).roleLabel).toBe(
      "Viewer",
    );
  });

  it.each([
    ["reader", "Viewer"],
    ["writer", "Editor"],
    ["manager", "Manager"],
  ])("labels the wire role %s as %s", (wire, label) => {
    expect(driveRowSharing({ ownerSs58: OWNER, role: wire }).roleLabel).toBe(
      label,
    );
  });
});

describe("rolesByLocalLabel", () => {
  it("indexes the drives that are actually synced here", () => {
    const map = rolesByLocalLabel([
      { localLabel: "team-docs", syncedLocally: true, role: "manager" },
      { localLabel: "design", syncedLocally: true, role: "reader" },
    ]);
    expect(map.get("team-docs")).toBe("manager");
    expect(map.get("design")).toBe("reader");
  });

  // A membership not yet added has no local label; it belongs to "Shared with
  // me", not to the drive list.
  it("skips memberships that are not synced locally", () => {
    const map = rolesByLocalLabel([
      { localLabel: null, syncedLocally: false, role: "writer" },
      { localLabel: "ghost", syncedLocally: false, role: "writer" },
      { syncedLocally: true, role: "writer" },
    ]);
    expect(map.size).toBe(0);
  });

  it("degrades an unknown role rather than storing it raw", () => {
    const map = rolesByLocalLabel([
      { localLabel: "odd", syncedLocally: true, role: "superuser" },
    ]);
    expect(map.get("odd")).toBe("reader");
  });

  it("returns an empty index for an empty listing", () => {
    expect(rolesByLocalLabel([]).size).toBe(0);
  });
});

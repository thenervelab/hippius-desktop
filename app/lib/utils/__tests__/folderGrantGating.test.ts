import { describe, expect, it } from "vitest";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  canShareFolderGrant,
  folderRolesAvailable,
} from "@/app/lib/utils/folderGrantGating";

const folder = (label: string): FormattedUserFile =>
  ({ name: "Clients", isFolder: true, label }) as FormattedUserFile;

describe("folderRolesAvailable", () => {
  it("needs the lane flag AND a server with folder grants and roles", () => {
    expect(folderRolesAvailable(true, { folder_grants: true, folder_grant_roles: true })).toBe(true);
    expect(folderRolesAvailable(false, { folder_grants: true, folder_grant_roles: true })).toBe(false);
    expect(folderRolesAvailable(true, { folder_grants: true, folder_grant_roles: false })).toBe(false);
    expect(folderRolesAvailable(true, { folder_grants: false, folder_grant_roles: true })).toBe(false);
    expect(folderRolesAvailable(true, { folder_grants: true })).toBe(false);
    expect(folderRolesAvailable(true, null), "unknown reads as off").toBe(false);
  });
});

describe("canShareFolderGrant", () => {
  it("keeps today's rule: own drives only, once the server has folder grants", () => {
    expect(canShareFolderGrant(folder("mine"), true)).toBe(true);
    expect(canShareFolderGrant(folder("mine"), false)).toBe(false);
    expect(canShareFolderGrant(folder("team"), true, new Set(["team"]))).toBe(false);
  });

  it("lets a Manager share a folder in somebody else's drive, with folder roles", () => {
    const manageable = new Set(["team", "grant:5O~h~61"]);
    expect(canShareFolderGrant(folder("team"), true, new Set(["team"]), manageable)).toBe(true);
    expect(canShareFolderGrant(folder("grant:5O~h~61"), true, undefined, manageable)).toBe(true);
    expect(canShareFolderGrant(folder("viewer"), true, new Set(["viewer"]), manageable)).toBe(false);
  });

  it("never for a file", () => {
    expect(canShareFolderGrant({ ...folder("mine"), isFolder: false }, true)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";

import {
  UPLOADED_BY_UNRECORDED,
  matchesUploader,
  uploaderKind,
} from "../uploaderFilter";

const ME = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ME_POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const MEMBER = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";

const ctx = { sessionSs58: ME, driveOwnerSs58: OWNER };
const rows = {
  mine: { uploadedBy: ME },
  owners: { uploadedBy: OWNER },
  unrecorded: { uploadedBy: undefined },
  members: { uploadedBy: MEMBER },
  folder: { isFolder: true },
};

function pick(selected: string) {
  return Object.entries(rows)
    .filter(([, row]) => matchesUploader(row, selected, ctx))
    .map(([name]) => name);
}

describe("uploaderKind (the column)", () => {
  it("names each row the way ADDED BY shows it", () => {
    expect(uploaderKind(rows.mine, ctx)).toBe("you");
    expect(uploaderKind({ uploadedBy: ME_POLKADOT }, ctx)).toBe("you");
    expect(uploaderKind(rows.owners, ctx)).toBe("owner");
    expect(uploaderKind(rows.unrecorded, ctx)).toBe("owner-unrecorded");
    expect(uploaderKind(rows.unrecorded, { sessionSs58: ME })).toBe("unknown");
    expect(uploaderKind(rows.members, ctx)).toBe("member");
    expect(uploaderKind(rows.folder, ctx)).toBe("folder");
  });
});

describe("matchesUploader (the filter)", () => {
  // The bug: every row read "Owner" (nothing recorded), and picking the owner
  // found nothing.
  it("the owner returns exactly the rows shown as Owner, recorded or not", () => {
    expect(pick(OWNER)).toEqual(["owners", "unrecorded"]);
  });

  it("You, a member and Not recorded each return their own rows", () => {
    expect(pick(ME)).toEqual(["mine"]);
    expect(pick(ME_POLKADOT)).toEqual(["mine"]);
    expect(pick(MEMBER)).toEqual(["members"]);
    expect(pick(UPLOADED_BY_UNRECORDED)).toEqual(["unrecorded"]);
  });

  it("on your own drive, You is only what was recorded as yours", () => {
    const own = { sessionSs58: ME, driveOwnerSs58: ME };
    expect(matchesUploader(rows.mine, ME, own)).toBe(true);
    expect(matchesUploader(rows.unrecorded, ME, own)).toBe(false);
    expect(matchesUploader(rows.unrecorded, UPLOADED_BY_UNRECORDED, own)).toBe(true);
  });

  it("no choice keeps every row", () => {
    expect(matchesUploader(rows.folder, undefined, ctx)).toBe(true);
  });
});

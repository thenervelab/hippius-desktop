// The words on the Shared Drives page's empty, upgrade and error states:
// each says what goes there and the next step that is actually open to
// this account, and none says "nothing shared" about a list it could not
// load.

import { describe, expect, it } from "vitest";

import { NOT_ENTITLED_TITLE } from "@/components/page-sections/drive/share-dialog/SectionNoticeView";
import {
  SHARING_PLAN_REQUIREMENT,
  sharedDrivesEmptyCopy,
  sharedDrivesErrorCopy,
  sharedDrivesPartialErrorLine,
} from "../sharedDrivesCopy";

const ALL_COPY = [
  ...(["all", "with-you", "by-you"] as const).flatMap((scope) =>
    [true, false].map((canShare) => sharedDrivesEmptyCopy(scope, canShare)),
  ),
  ...(["all", "with-you", "by-you"] as const).flatMap((scope) =>
    [true, false].map((offline) => sharedDrivesErrorCopy(scope, offline)),
  ),
];

describe("the empty states", () => {
  it("offer Share a drive with nothing either way, and say drives shared with you land here too", () => {
    const copy = sharedDrivesEmptyCopy("all", true);
    expect(copy.action).toBe("share");
    expect(copy.description).toMatch(/Share a drive/);
    expect(copy.description).toMatch(/share with you show up here/);
  });

  it("offer the upgrade instead on a plan without sharing, and say joining works on any plan", () => {
    const copy = sharedDrivesEmptyCopy("all", false);
    expect(copy.action).toBe("upgrade");
    expect(copy.description).toMatch(/Plus, Max and Scale/);
    expect(copy.description).toMatch(/any plan/);
  });

  it("give Shared with you nothing to click, on any plan: it is somebody else's move", () => {
    expect(sharedDrivesEmptyCopy("with-you", true).action).toBeNull();
    expect(sharedDrivesEmptyCopy("with-you", false).action).toBeNull();
    expect(sharedDrivesEmptyCopy("with-you", true).description).toMatch(/invites you/);
    expect(sharedDrivesEmptyCopy("with-you", false).description).toMatch(/You can join on any plan/);
  });

  it("start sharing from an empty Shared by you, or upgrade on a plan that cannot", () => {
    expect(sharedDrivesEmptyCopy("by-you", true)).toMatchObject({ action: "share" });
    expect(sharedDrivesEmptyCopy("by-you", false)).toMatchObject({ action: "upgrade", title: SHARING_PLAN_REQUIREMENT });
  });

  it("word the plan requirement as the Share dialog's upgrade card does", () => {
    expect(SHARING_PLAN_REQUIREMENT).toBe(NOT_ENTITLED_TITLE);
  });
});

describe("the error states", () => {
  it("name what failed, by tab", () => {
    expect(sharedDrivesErrorCopy("all", false).title).toBe("Couldn't load shared drives");
    expect(sharedDrivesErrorCopy("with-you", false).title).toMatch(/shared with you/);
    expect(sharedDrivesErrorCopy("by-you", false).title).toMatch(/you've shared/);
  });

  it("say the files are safe, and that an offline list loads again once back online", () => {
    expect(sharedDrivesErrorCopy("all", false).description).toMatch(/safe/);
    expect(sharedDrivesErrorCopy("all", true).description).toMatch(/offline/);
    expect(sharedDrivesErrorCopy("all", true).description).toMatch(/back online/);
  });

  it("call out the missing half above the rows that did load", () => {
    expect(sharedDrivesPartialErrorLine(["with-you"])).toMatch(/shared with you/);
    expect(sharedDrivesPartialErrorLine(["by-you"])).toMatch(/you've shared/);
    expect(sharedDrivesPartialErrorLine(["by-you", "with-you"])).toMatch(/Some shared drives/);
  });
});

describe("all of it", () => {
  it("never claims nothing is shared from an error", () => {
    for (const scope of ["all", "with-you", "by-you"] as const) {
      expect(sharedDrivesErrorCopy(scope, false).title).not.toMatch(/nothing|no drives/i);
    }
  });

  it("carries no em dash", () => {
    for (const copy of ALL_COPY) {
      expect(`${copy.title} ${copy.description}`).not.toMatch(/\u2014/);
    }
  });
});

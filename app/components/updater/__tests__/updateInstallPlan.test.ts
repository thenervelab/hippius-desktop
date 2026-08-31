import { describe, expect, it } from "vitest";

import { getUpdateInstallPlan } from "@/app/components/updater/updateInstallPlan";

const RELEASES = "https://github.com/thenervelab/hippius-desktop/releases";
const HINT =
  "Download the .deb from https://github.com/thenervelab/hippius-desktop/releases and install it with your package manager.";

describe("getUpdateInstallPlan", () => {
  it("installs in place when Rust says the bundle supports it", () => {
    expect(
      getUpdateInstallPlan({
        installInPlace: true,
        releasePageUrl: RELEASES,
        manualInstallHint: HINT,
      }),
    ).toEqual({ kind: "in-place" });
  });

  it("does not call install when the updater target cannot be applied as this user", () => {
    expect(
      getUpdateInstallPlan({
        installInPlace: false,
        releasePageUrl: RELEASES,
        manualInstallHint: HINT,
      }),
    ).toEqual({ kind: "manual", url: RELEASES, hint: HINT });
  });
});

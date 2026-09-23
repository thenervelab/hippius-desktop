import { describe, expect, it } from "vitest";

import { truncateInviteUrl } from "../inviteLink";

describe("truncateInviteUrl", () => {
  it("strips the #k= fragment and truncates the token", () => {
    expect(
      truncateInviteUrl(
        "https://console.hippius.com/invite/Zm9vYmFyLXRva2VuLXRoaXJ0eS10d28#k=secret",
      ),
    ).toBe("https://console.hippius.com/invite/Zm9vYmFy…");
  });

  it("never leaves the fragment visible even for a short token", () => {
    expect(truncateInviteUrl("https://x/invite/ab#k=DRIVEKEY")).toBe(
      "https://x/invite/ab…",
    );
    expect(truncateInviteUrl("https://x/invite/ab#k=DRIVEKEY")).not.toContain(
      "DRIVEKEY",
    );
    expect(truncateInviteUrl("https://x/invite/ab#k=DRIVEKEY")).not.toContain(
      "#k=",
    );
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "app/components/auth/OAuthButtons.tsx"),
  "utf8",
);

describe("OAuth provider buttons", () => {
  // Apple was rendered permanently disabled with a comment saying the
  // backend was not ready. It has been ready — `start_oauth_flow` maps
  // "apple" to the same /accounts/apple/login/ path the console uses — so
  // the button was hardcoded off against a condition that no longer held.
  // A hardcoded `disabled={true}` is invisible in the UI and easy to
  // reintroduce, so it is pinned here.
  it("offers every supported provider on the same terms", () => {
    for (const provider of ["google", "github", "apple"]) {
      expect(source).toContain(`<OAuthButton provider="${provider}" disabled={disabled} />`);
    }
  });

  it("hardcodes no provider as disabled", () => {
    expect(source).not.toMatch(/<OAuthButton[^>]*disabled=\{true\}/);
  });
});

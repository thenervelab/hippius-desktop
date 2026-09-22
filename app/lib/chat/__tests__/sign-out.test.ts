import { describe, expect, it } from "vitest";

import { sessionsListUrl } from "@/lib/chat/sign-out";

describe("sessionsListUrl", () => {
  it("points the IdP's account page at its sessions list (MSC2965 action)", () => {
    const url = sessionsListUrl("https://auth.hippius.com/account/");
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin + parsed.pathname).toBe("https://auth.hippius.com/account/");
    expect(parsed.searchParams.get("action")).toBe("org.matrix.sessions_list");
  });

  it("keeps the IdP's own query parameters and overrides only the action", () => {
    const url = sessionsListUrl("https://auth.example/account?tenant=t&action=profile");
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("tenant")).toBe("t");
    expect(parsed.searchParams.get("action")).toBe("org.matrix.sessions_list");
  });

  it("is null when the server advertises nothing or garbage, so the entry is hidden", () => {
    expect(sessionsListUrl(undefined)).toBeNull();
    expect(sessionsListUrl(null)).toBeNull();
    expect(sessionsListUrl("")).toBeNull();
    expect(sessionsListUrl("not a url")).toBeNull();
  });
});

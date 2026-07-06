import { describe, it, expect } from "vitest";
import { resolveVmVpnView } from "../vmVpnView";

describe("resolveVmVpnView", () => {
  it("is unsupported (all actions off) when the build lacks a real engine", () => {
    const v = resolveVmVpnView(false, { kind: "disconnected" });
    expect(v.phase).toBe("unsupported");
    expect(v.canConnect).toBe(false);
    expect(v.canDisconnect).toBe(false);
    expect(v.canOpen).toBe(false);
  });

  it("unsupported wins even if the status somehow says connected", () => {
    // Defensive: capability gate dominates live status.
    const v = resolveVmVpnView(false, { kind: "connected" });
    expect(v.phase).toBe("unsupported");
    expect(v.canOpen).toBe(false);
  });

  it("treats a null status as disconnected once supported", () => {
    const v = resolveVmVpnView(true, null);
    expect(v.phase).toBe("disconnected");
    expect(v.canConnect).toBe(true);
    expect(v.canOpen).toBe(false);
  });

  it("connected enables disconnect + opening VM connections, not connect", () => {
    const v = resolveVmVpnView(true, { kind: "connected" });
    expect(v.phase).toBe("connected");
    expect(v.canConnect).toBe(false);
    expect(v.canDisconnect).toBe(true);
    expect(v.canOpen).toBe(true);
  });

  it("connecting disables every action (transient)", () => {
    const v = resolveVmVpnView(true, { kind: "connecting" });
    expect(v.phase).toBe("connecting");
    expect(v.canConnect).toBe(false);
    expect(v.canDisconnect).toBe(false);
    expect(v.canOpen).toBe(false);
  });

  it("error is recoverable: allows retrying connect and surfaces the message", () => {
    const v = resolveVmVpnView(true, { kind: "error", message: "enrollment failed: boom" });
    expect(v.phase).toBe("error");
    expect(v.canConnect).toBe(true);
    expect(v.canOpen).toBe(false);
    expect(v.message).toContain("boom");
  });

  it("error without a message falls back to a generic line", () => {
    const v = resolveVmVpnView(true, { kind: "error" });
    expect(v.message).toBe("VPN error.");
  });
});

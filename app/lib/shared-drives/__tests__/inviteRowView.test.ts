import { describe, expect, it } from "vitest";

import {
  deadReasonLabel,
  inviteRowView,
} from "@/app/lib/shared-drives/inviteRowView";

const NOW = new Date("2026-09-17T12:00:00Z");
const base = {
  role: "writer",
  expiresAt: "2026-10-04T12:00:00Z",
  maxUses: 50,
  useCount: 2,
  revoked: false,
  valid: true,
};

describe("inviteRowView", () => {
  it("says the role and how far the link has gone", () => {
    expect(inviteRowView(base, NOW).summary).toBe("Editor · 2 of 50 used");
  });

  it("reads the role people recognise, not the wire word", () => {
    expect(inviteRowView({ ...base, role: "manager" }, NOW).summary).toContain(
      "Manager",
    );
    expect(inviteRowView({ ...base, role: "reader" }, NOW).summary).toContain(
      "Viewer",
    );
  });

  it("dates a real expiry", () => {
    expect(inviteRowView(base, NOW).expiry).toMatch(/Expires/);
    expect(inviteRowView(base, NOW).live).toBe(true);
  });

  // The server expresses "never" as a 100-year cap. Rendering that as a date
  // would be technically true and useless.
  it("calls the 100-year sentinel what it is", () => {
    const view = inviteRowView(
      { ...base, expiresAt: "2126-09-12T12:00:00Z" },
      NOW,
    );
    expect(view.expiry).toBe("Never expires");
    expect(view.live).toBe(true);
  });

  it("marks a past expiry dead", () => {
    const view = inviteRowView(
      { ...base, expiresAt: "2026-09-01T12:00:00Z", valid: false },
      NOW,
    );
    expect(view.expiry).toBe("Expired");
    expect(view.live).toBe(false);
    expect(view.deadReason).toBe("expired");
  });

  // A link the user revoked should say so, not report the incidental fact
  // that time also passed.
  it("prefers revoked over expired when both are true", () => {
    const view = inviteRowView(
      {
        ...base,
        revoked: true,
        valid: false,
        expiresAt: "2026-09-01T12:00:00Z",
      },
      NOW,
    );
    expect(view.deadReason).toBe("revoked");
  });

  it("marks an exhausted link used-up", () => {
    const view = inviteRowView(
      { ...base, useCount: 50, maxUses: 50, valid: false },
      NOW,
    );
    expect(view.deadReason).toBe("used-up");
    expect(view.live).toBe(false);
  });

  // The server's verdict is the authority; the reasons only explain it.
  it("trusts the server calling a link invalid", () => {
    expect(inviteRowView({ ...base, valid: false }, NOW).live).toBe(false);
  });

  it("does not crash on an unparseable date", () => {
    const view = inviteRowView({ ...base, expiresAt: "not-a-date" }, NOW);
    expect(view.expiry).toBe("Expiry unknown");
  });
});

describe("deadReasonLabel", () => {
  it.each([
    ["revoked", "Revoked"],
    ["expired", "Expired"],
    ["used-up", "All uses taken"],
  ] as const)("labels %s", (reason, label) => {
    expect(deadReasonLabel(reason)).toBe(label);
  });

  it("says nothing for a live link", () => {
    expect(deadReasonLabel(null)).toBe("");
  });
});

// Provenance earns its place only now that a MANAGER can mint too: before,
// every link on a drive came from its owner and "by you" on every row was
// noise.
describe("who minted a link", () => {
  const base = {
    role: "writer",
    expiresAt: "2126-01-01T00:00:00Z",
    maxUses: 50,
    useCount: 0,
    revoked: false,
    valid: true,
  };

  it("names a manager's link when the owner is reading", () => {
    const view = inviteRowView({ ...base, mintedBy: "5Manager" }, undefined, "5Owner");
    expect(view.mintedBy).toBe("5Manager");
  });

  it("says nothing about the reader's own link", () => {
    const view = inviteRowView({ ...base, mintedBy: "5Owner" }, undefined, "5Owner");
    expect(view.mintedBy).toBeNull();
  });

  // Invites predating provenance carry an empty string, which must not
  // render as a blank "by".
  it("says nothing when the server has no provenance", () => {
    expect(inviteRowView({ ...base, mintedBy: "" }, undefined, "5Owner").mintedBy).toBeNull();
    expect(inviteRowView({ ...base, mintedBy: "   " }, undefined, "5Owner").mintedBy).toBeNull();
    expect(inviteRowView(base, undefined, "5Owner").mintedBy).toBeNull();
  });

  it("names it when the reader is unknown", () => {
    expect(inviteRowView({ ...base, mintedBy: "5Someone" }).mintedBy).toBe("5Someone");
  });
});

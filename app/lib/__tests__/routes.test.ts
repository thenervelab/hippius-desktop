import { describe, it, expect } from "vitest";
import { BILLING_ROUTE, driveFolderRoute } from "../routes";

describe("driveFolderRoute", () => {
  it("names the folder to open", () => {
    expect(driveFolderRoute("chains", false)).toBe("/files?openLabel=chains");
  });

  // Local and server-only folders open through different paths on the
  // Drive page, and guessing from the label is the H-077 mistake.
  it("marks a server-only folder as remote", () => {
    expect(driveFolderRoute("Camera Uploads", true)).toContain("openRemote=1");
    expect(driveFolderRoute("chains", false)).not.toContain("openRemote");
  });

  // Labels come from folder names, which contain spaces, & and #.
  it("encodes a label that would otherwise break the query", () => {
    const route = driveFolderRoute("Photos & Video #1", false);
    expect(route).not.toContain(" ");
    const value = new URLSearchParams(route.split("?")[1]).get("openLabel");
    expect(value).toBe("Photos & Video #1");
  });

  it("round-trips a suffixed label unchanged", () => {
    // Two folders sharing a basename get `tags` and `tags-2`; opening by
    // display name would land on the wrong drive.
    const route = driveFolderRoute("tags-2", false);
    expect(new URLSearchParams(route.split("?")[1]).get("openLabel")).toBe("tags-2");
  });
});

describe("BILLING_ROUTE", () => {
  it("points at the billing section of settings", () => {
    expect(BILLING_ROUTE).toBe("/settings?section=billing");
  });
});

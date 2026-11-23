import { describe, expect, it } from "vitest";

import {
  allowListSummary,
  ANYONE_WITH_EMAIL,
  downloadSummary,
  expirySummary,
  NDA_ELSEWHERE,
  NDA_OFF_VALUE,
  ndaSummary,
  PASSWORD_VALUE,
  passwordSummary,
  RULE_ORDER,
  WATERMARK_OFF_VALUE,
  WATERMARK_PDF_ONLY,
  WATERMARK_VALUE,
  WATERMARK_WHEN_VIEW_ONLY,
  watermarkSummary,
} from "../ruleSummaries";

const gate = (more: Partial<Parameters<typeof allowListSummary>[0]> = {}) => ({
  on: true,
  allowCount: 0,
  blockCount: 0,
  lists: { allow: [], block: [] },
  ...more,
});

describe("rule card words", () => {
  it("keeps the console's order", () => {
    expect(RULE_ORDER).toEqual(["gate", "allowList", "nda", "watermark", "download", "expiry", "password"]);
  });

  it("names the allow list's domains and counts its emails and blocks", () => {
    expect(allowListSummary(gate({ lists: { allow: ["acme.com", "bob@x.com"], block: [] } }))).toEqual({
      on: true,
      value: "acme.com, 1 email",
    });
    expect(
      allowListSummary(gate({ lists: { allow: ["a.com", "b.com", "c.com", "x@y.com", "z@y.com"], block: ["bad.com"] } })),
    ).toEqual({ on: true, value: "a.com, b.com +1, 2 emails, 1 blocked" });
  });

  it("is off with nobody listed, or while the gate is off", () => {
    expect(allowListSummary(gate())).toEqual({ on: false, value: ANYONE_WITH_EMAIL });
    expect(allowListSummary(gate({ on: false, allowCount: 3 }))).toEqual({ on: false, value: ANYONE_WITH_EMAIL });
  });

  it("falls back to the counts when the lists don't open here", () => {
    expect(allowListSummary(gate({ lists: null, allowCount: 3, blockCount: 1 }))).toEqual({
      on: true,
      value: "3 allowed, 1 blocked",
    });
  });

  it("shows the NDA's first line, or where it was set", () => {
    expect(ndaSummary({ on: true, text: "\n  MUTUAL NDA  \nBody" })).toEqual({ on: true, value: "MUTUAL NDA" });
    expect(ndaSummary({ on: true, text: null })).toEqual({ on: true, value: NDA_ELSEWHERE });
    expect(ndaSummary({ on: false, text: null })).toEqual({ on: false, value: NDA_OFF_VALUE });
  });

  it("reads the watermark as today's rule: a PDF while downloads are off", () => {
    expect(watermarkSummary("deck.PDF", null, false)).toEqual({ on: true, value: WATERMARK_VALUE });
    expect(watermarkSummary("scan", "application/pdf", false)).toEqual({ on: true, value: WATERMARK_VALUE });
    expect(watermarkSummary("deck.pdf", null, true)).toEqual({ on: false, value: WATERMARK_WHEN_VIEW_ONLY });
    // A server without the download switch always allows downloads.
    expect(watermarkSummary("deck.pdf", null, null)).toEqual({ on: false, value: WATERMARK_WHEN_VIEW_ONLY });
    expect(watermarkSummary("clip.mp4", null, false)).toEqual({ on: false, value: WATERMARK_PDF_ONLY });
  });

  it("reads the watermark's own switch where the server has one, whatever downloads say", () => {
    expect(watermarkSummary("deck.pdf", null, true, true)).toEqual({ on: true, value: WATERMARK_VALUE });
    expect(watermarkSummary("deck.pdf", null, false, false)).toEqual({ on: false, value: WATERMARK_OFF_VALUE });
    // Still drawn on PDFs only.
    expect(watermarkSummary("clip.mp4", null, true, true)).toEqual({ on: false, value: WATERMARK_PDF_ONLY });
  });

  it("words download, expiry and password", () => {
    expect(downloadSummary(true).on).toBe(true);
    expect(downloadSummary(false)).toEqual({ on: false, value: "View only" });
    expect(expirySummary(null)).toEqual({ on: false, value: "Never" });
    const dated = expirySummary("2026-12-20T12:00:00Z");
    expect(dated.on).toBe(true);
    expect(dated.value).toBe(new Date("2026-12-20T12:00:00Z").toLocaleDateString(undefined, { dateStyle: "medium" }));
    expect(passwordSummary(false)).toEqual({ on: false, value: PASSWORD_VALUE });
  });
});

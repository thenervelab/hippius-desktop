import { describe, expect, it } from "vitest";

import {
  allowListSummary,
  ANYONE,
  downloadSummary,
  expirySummary,
  gateSummary,
  GATE_OFF_VALUE,
  GATE_VALUE,
  NDA_ELSEWHERE,
  NDA_OFF_VALUE,
  ndaSummary,
  PASSWORD_OFF_VALUE,
  PASSWORD_VALUE,
  passwordSummary,
  RULE_ORDER,
  WATERMARK_OFF_VALUE,
  WATERMARK_PDF_ONLY,
  WATERMARK_VALUE,
  WATERMARK_WHEN_VIEW_ONLY,
  WATERMARK_WITH_EMAIL,
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

  it("counts the allow list short enough never to be cut, the same whether the lists open here or not", () => {
    expect(allowListSummary(gate({ lists: { allow: ["acme.com", "bob@x.com"], block: [] } }))).toEqual({
      on: null,
      value: "2 allowed",
    });
    const open = allowListSummary(
      gate({ allowCount: 5, blockCount: 1, lists: { allow: ["a.com", "b.com", "c.com", "x@y.com", "z@y.com"], block: ["bad.com"] } }),
    );
    expect(open).toEqual({ on: null, value: "5 allowed, 1 blocked" });
    expect(allowListSummary(gate({ allowCount: 5, blockCount: 1, lists: null }))).toEqual(open);
  });

  it("reads Anyone with nobody listed, or while the gate is off, and never says On or Off", () => {
    expect(allowListSummary(gate())).toEqual({ on: null, value: ANYONE });
    expect(allowListSummary(gate({ on: false, allowCount: 3 }))).toEqual({ on: null, value: ANYONE });
  });

  it("falls back to the counts when the lists don't open here", () => {
    expect(allowListSummary(gate({ lists: null, allowCount: 3, blockCount: 1 }))).toEqual({
      on: null,
      value: "3 allowed, 1 blocked",
    });
  });

  it("says what Ask for email does now, not what it would do", () => {
    expect(gateSummary(true)).toEqual({ on: true, value: GATE_VALUE });
    expect(gateSummary(false)).toEqual({ on: false, value: GATE_OFF_VALUE });
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
    expect(watermarkSummary("clip.mp4", null, false)).toEqual({ on: null, value: WATERMARK_PDF_ONLY });
  });

  it("names the email in the watermark only when the link asks for one", () => {
    expect(watermarkSummary("deck.pdf", null, true, true, true)).toEqual({ on: true, value: WATERMARK_WITH_EMAIL });
    expect(watermarkSummary("deck.pdf", null, false, null, true)).toEqual({ on: true, value: WATERMARK_WITH_EMAIL });
    expect(watermarkSummary("deck.pdf", null, true, true, false)).toEqual({ on: true, value: WATERMARK_VALUE });
  });

  it("reads the watermark's own switch where the server has one, whatever downloads say", () => {
    expect(watermarkSummary("deck.pdf", null, true, true)).toEqual({ on: true, value: WATERMARK_VALUE });
    expect(watermarkSummary("deck.pdf", null, false, false)).toEqual({ on: false, value: WATERMARK_OFF_VALUE });
    // Still drawn on PDFs only.
    expect(watermarkSummary("clip.mp4", null, true, true)).toEqual({ on: null, value: WATERMARK_PDF_ONLY });
  });

  it("words download, expiry and password", () => {
    expect(downloadSummary(true).on).toBe(true);
    expect(downloadSummary(false)).toEqual({ on: false, value: "View only" });
    expect(expirySummary(null)).toEqual({ on: null, value: "Never" });
    const dated = expirySummary("2026-12-20T12:00:00Z");
    expect(dated.on).toBeNull();
    expect(dated.value).toBe(new Date("2026-12-20T12:00:00Z").toLocaleDateString(undefined, { dateStyle: "medium" }));
    expect(passwordSummary(true)).toEqual({ on: true, value: PASSWORD_VALUE });
    expect(passwordSummary(false)).toEqual({ on: false, value: PASSWORD_OFF_VALUE });
  });
});

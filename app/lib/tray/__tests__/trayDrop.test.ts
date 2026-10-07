import { describe, expect, it, vi } from "vitest";
import {
  parkTrayDrop,
  parseTrayDropPayload,
  takeTrayDrop,
  TRAY_DROP_WAITING_EVENT,
} from "../trayDrop";

describe("files dropped on the tray popover", () => {
  it("are read from a well-formed payload only (it crosses a webview)", () => {
    expect(parseTrayDropPayload({ paths: ["/a.png", "/b.pdf"] })).toEqual(["/a.png", "/b.pdf"]);
    expect(parseTrayDropPayload({ paths: ["/a.png", 3, ""] })).toEqual(["/a.png"]);
    expect(parseTrayDropPayload({ paths: [] })).toBeNull();
    expect(parseTrayDropPayload({ paths: "/a.png" })).toBeNull();
    expect(parseTrayDropPayload(null)).toBeNull();
    expect(parseTrayDropPayload("x")).toBeNull();
  });

  it("are parked for the Drive page, which is told, and taken once", () => {
    const told = vi.fn();
    window.addEventListener(TRAY_DROP_WAITING_EVENT, told);
    parkTrayDrop(["/a.png"]);
    expect(told).toHaveBeenCalledTimes(1);
    expect(takeTrayDrop()).toEqual(["/a.png"]);
    // A second Drive page mount must not upload them again.
    expect(takeTrayDrop()).toBeNull();
    window.removeEventListener(TRAY_DROP_WAITING_EVENT, told);
  });

  it("keep only the latest drop when two arrive before the page takes them", () => {
    parkTrayDrop(["/old.png"]);
    parkTrayDrop(["/new.png"]);
    expect(takeTrayDrop()).toEqual(["/new.png"]);
  });
});

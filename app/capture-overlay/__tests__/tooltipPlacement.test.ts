import { describe, expect, it } from "vitest";
import { placeTooltip, TIP_EDGE, TIP_GAP } from "@/app/capture-overlay/tooltipPlacement";

const SCREEN = { width: 1440, height: 900 };
const TIP = { width: 160, height: 28 };
const button = (left: number, top: number) => ({ left, top, width: 40, height: 36 });

describe("where the capture bar's tooltip goes", () => {
  it("sits above the button, centred on it", () => {
    const place = placeTooltip(button(700, 820), TIP, SCREEN);
    expect(place.side).toBe("above");
    expect(place.top).toBe(820 - TIP_GAP - TIP.height);
    expect(place.left).toBe(700 + 20 - 80);
  });

  it("goes below only when there is no room above", () => {
    const place = placeTooltip(button(700, 20), TIP, SCREEN);
    expect(place.side).toBe("below");
    expect(place.top).toBe(20 + 36 + TIP_GAP);
  });

  it("keeps clear of the left and right edges", () => {
    expect(placeTooltip(button(0, 820), TIP, SCREEN).left).toBe(TIP_EDGE);
    expect(placeTooltip(button(1420, 820), TIP, SCREEN).left).toBe(SCREEN.width - TIP_EDGE - TIP.width);
  });

  it("stays inside a window with room on neither side (Wayland's fitted panel)", () => {
    const panel = { width: 640, height: 80 };
    const place = placeTooltip({ left: 300, top: 20, width: 40, height: 36 }, { width: 200, height: 44 }, panel);
    expect(place.top).toBeGreaterThanOrEqual(TIP_EDGE);
    expect(place.top).toBe(panel.height - TIP_EDGE - 44);
  });

  it("starts at the left edge when it is wider than the window", () => {
    expect(placeTooltip(button(100, 820), { width: 500, height: 28 }, { width: 400, height: 900 }).left).toBe(TIP_EDGE);
  });
});

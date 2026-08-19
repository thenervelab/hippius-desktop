// Regression: hovering a bar and then shrinking the data crashed the chart
// (PR #124 review P2-1). `hoveredIndex` is cleared only by `onMouseLeave`,
// which does not fire when the data shrinks under a stationary cursor — a
// window resize past the narrow breakpoint re-samples the series, and a
// background refetch can return fewer points or the empty fallback. The
// derived `hoveredBarTopY` then indexed `displayData[hoveredIndex].balance`
// on an out-of-range index and threw during render, unmounting the home
// subtree to the nearest error boundary.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import StorageBarChart from "@/components/page-sections/home/storage-usage/StorageBarChart";
import type { ChartPoint } from "@/lib/types/chartTypes";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const realResizeObserver = globalThis.ResizeObserver;
const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  // jsdom has no layout: give the container a real size so the SVG (and its
  // per-slot hover hit-areas) actually render.
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    width: 800,
    height: 300,
    top: 0,
    left: 0,
    bottom: 300,
    right: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
});

function makeSeries(n: number): ChartPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    x: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    balance: (i + 1) * 1000,
    formattedBalance: `${i + 1} KB`,
    timestamp: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    dayLabel: `D${i + 1}`,
  }));
}

/** The transparent per-slot hit rects that own the hover handlers. */
function hitRects(container: HTMLElement): SVGRectElement[] {
  return Array.from(
    container.querySelectorAll<SVGRectElement>('svg rect[fill="transparent"]')
  );
}

describe("StorageBarChart hover vs shrinking data", () => {
  it("survives the data shrinking below the hovered index (and drops the tooltip)", () => {
    const { container, rerender } = render(
      <StorageBarChart data={makeSeries(30)} yTickFormat={(v) => String(v)} />
    );

    const rects = hitRects(container);
    expect(rects.length).toBe(30);
    fireEvent.mouseEnter(rects[20]!);

    // 30 → 5 points with the cursor stationary: no mouseleave fires. The
    // old derivation threw a TypeError during this render.
    expect(() =>
      rerender(
        <StorageBarChart data={makeSeries(5)} yTickFormat={(v) => String(v)} />
      )
    ).not.toThrow();

    // The stale hover is dropped rather than remapped to a different day.
    expect(hitRects(container).length).toBe(5);
    expect(container.textContent).not.toContain("21 KB");
  });

  it("survives the data collapsing to the empty-state fallback mid-hover", () => {
    const { container, rerender } = render(
      <StorageBarChart data={makeSeries(10)} yTickFormat={(v) => String(v)} />
    );

    fireEvent.mouseEnter(hitRects(container)[9]!);

    expect(() =>
      rerender(<StorageBarChart data={[]} yTickFormat={(v) => String(v)} />)
    ).not.toThrow();

    // Empty fallback renders its 7 zero bars.
    expect(hitRects(container).length).toBe(7);
  });
});

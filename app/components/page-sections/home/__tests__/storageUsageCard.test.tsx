// Guard for the Storage Usage card's data projection.
//
// The card used to diff the backend's cumulative series into per-day "bytes
// added" bars (`storageDeltaUtils.cumulativeToDeltas`), which is why it
// contradicted its own "Total Storage Used" headline: the headline is a running
// total, the bars were deltas, and a deletion silently clamped to 0. The fix was
// to delete that projection and plot `get_drive_storage_chart` as-is. The bars
// are back as the MARK (StorageBarChart), but they still plot the cumulative
// level: the only projection allowed between the hook and the chart is
// `sampleCumulativeBars`, which picks WHICH days get a bar and never transforms
// values.
//
// A pure-function test can't guard that, because the original fix was the
// *removal* of a function. So this asserts at the render boundary: whatever the
// hook returns is what the chart is handed (modulo display sampling).
// Reintroducing any diff here fails this file.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import type { ChartPoint } from "@/lib/types/chartTypes";

const chartSpy = vi.fn();

vi.mock("@/app/lib/hooks/api/useDriveStorageChart", () => ({
  useDriveStorageChart: () => ({
    data: mockChartData,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/app/lib/hooks/api/useDriveStorageStats", () => ({
  useDriveStorageStats: () => ({
    data: { totalBytes: 300, fileCount: 3 },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

// Stand-in for the bar chart: records the props the card passes and renders
// the plotted values so they can be asserted from the DOM.
vi.mock(
  "@/components/page-sections/home/storage-usage/StorageBarChart",
  () => ({
    default: (props: {
      data: ChartPoint[];
      yTickFormat?: (v: number) => string;
    }) => {
      chartSpy(props);
      return (
        <div
          data-testid="chart"
          data-balances={JSON.stringify(props.data.map((p) => p.balance))}
          data-has-tick-format={String(Boolean(props.yTickFormat))}
          data-sample-tick={props.yTickFormat?.(1_500_000_000) ?? ""}
        />
      );
    },
  }),
);

import StorageUsageCard from "../storage-usage";

/**
 * A cumulative daily total: storage sits at 100 B for two days, then a 200 B
 * upload lands. Chosen so the two projections are impossible to confuse — the
 * deleted delta logic would have produced [0, 0, 200].
 */
let mockChartData: ChartPoint[] = [];

function point(balance: number, day: number): ChartPoint {
  const dd = String(day).padStart(2, "0");
  return {
    x: `2026-05-${dd}T00:00:00.000Z`,
    balance,
    formattedBalance: `${balance} B`,
    timestamp: `2026-05-${dd}`,
    dayLabel: `${dd} May`,
  };
}

function plottedBalances(): number[] {
  return JSON.parse(
    screen.getByTestId("chart").getAttribute("data-balances") ?? "[]",
  );
}

beforeEach(() => {
  chartSpy.mockClear();
  mockChartData = [point(100, 1), point(100, 2), point(300, 3)];
});

describe("StorageUsageCard data projection", () => {
  it("plots the cumulative total, not per-day deltas", () => {
    render(<StorageUsageCard />);

    const balances = plottedBalances();
    expect(balances).toEqual([100, 100, 300]);
    // The shape the old delta projection produced. Named explicitly so the
    // failure message says what regressed.
    expect(balances).not.toEqual([0, 0, 200]);
  });

  it("keeps a deletion visible as a drop instead of clamping it to zero", () => {
    // `cumulativeToDeltas` used `Math.max(0, ...)`, so freeing space rendered as
    // "nothing happened". On cumulative bars it must read as a shorter bar.
    mockChartData = [point(300, 1), point(120, 2)];
    render(<StorageUsageCard />);

    expect(plottedBalances()).toEqual([300, 120]);
  });

  it("downsamples long ranges for display but never loses the last point", () => {
    // 31 cumulative readings ending on a distinctive value: the default
    // last7days view draws at most 7 bars, every bar is an untouched reading
    // from the series, and the final bar is the series' last point — the same
    // value the headline shows.
    mockChartData = Array.from({ length: 31 }, (_, i) =>
      point(1000 + i * 10, i + 1),
    );
    render(<StorageUsageCard />);

    const balances = plottedBalances();
    expect(balances.length).toBeLessThanOrEqual(7);
    expect(balances[balances.length - 1]).toBe(1300);
    for (const b of balances) {
      expect(mockChartData.some((p) => p.balance === b)).toBe(true);
    }
  });

  it("formats y-axis ticks as bytes", () => {
    // The bar chart has no default tick format; without the byte formatter
    // 1.5 GB would render as a raw number.
    render(<StorageUsageCard />);

    const chart = screen.getByTestId("chart");
    expect(chart.getAttribute("data-has-tick-format")).toBe("true");
    expect(chart.getAttribute("data-sample-tick")).toMatch(/GB$/);
  });

  it("passes an empty series through when the hook returns nothing", () => {
    mockChartData = [];
    render(<StorageUsageCard />);

    expect(plottedBalances()).toEqual([]);
  });
});

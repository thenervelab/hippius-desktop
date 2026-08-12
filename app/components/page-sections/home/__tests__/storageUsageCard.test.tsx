// Guard for the Storage Usage card's data projection.
//
// The card used to diff the backend's cumulative series into per-day "bytes
// added" bars (`storageDeltaUtils.cumulativeToDeltas`), which is why it
// contradicted its own "Total Storage Used" headline: the headline is a running
// total, the bars were deltas, and a deletion silently clamped to 0. The fix was
// to delete that projection and plot `get_drive_storage_chart` as-is.
//
// A pure-function test can't guard that, because the fix was the *removal* of a
// function. So this asserts at the render boundary: whatever the hook returns is
// what the chart is handed. Reintroducing any diff here fails this file.

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

// Stand-in for the shared area chart: records the props the card passes and
// renders the plotted values so they can be asserted from the DOM.
vi.mock(
  "@/components/page-sections/home/available-credits/AvailableCreditsChart",
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

function point(balance: number, day: string): ChartPoint {
  return {
    x: `2026-05-0${day}T00:00:00.000Z`,
    balance,
    formattedBalance: `${balance} B`,
    timestamp: `2026-05-0${day}`,
    dayLabel: `0${day} May`,
  };
}

beforeEach(() => {
  chartSpy.mockClear();
  mockChartData = [point(100, "1"), point(100, "2"), point(300, "3")];
});

describe("StorageUsageCard data projection", () => {
  it("plots the cumulative total, not per-day deltas", () => {
    render(<StorageUsageCard />);

    const balances = JSON.parse(
      screen.getByTestId("chart").getAttribute("data-balances") ?? "[]",
    );
    expect(balances).toEqual([100, 100, 300]);
    // The shape the old delta projection produced. Named explicitly so the
    // failure message says what regressed.
    expect(balances).not.toEqual([0, 0, 200]);
  });

  it("keeps a deletion visible as a drop instead of clamping it to zero", () => {
    // `cumulativeToDeltas` used `Math.max(0, ...)`, so freeing space rendered as
    // "nothing happened". On a cumulative line it must read as a decline.
    mockChartData = [point(300, "1"), point(120, "2")];
    render(<StorageUsageCard />);

    const balances = JSON.parse(
      screen.getByTestId("chart").getAttribute("data-balances") ?? "[]",
    );
    expect(balances).toEqual([300, 120]);
  });

  it("formats y-axis ticks as bytes", () => {
    // Without an explicit yTickFormat the shared chart falls back to its
    // credit-unit abbreviations and labels 1.5 GB as "1500.0M".
    render(<StorageUsageCard />);

    const chart = screen.getByTestId("chart");
    expect(chart.getAttribute("data-has-tick-format")).toBe("true");
    expect(chart.getAttribute("data-sample-tick")).toMatch(/GB$/);
  });

  it("passes the series through untouched when the hook returns nothing", () => {
    mockChartData = [];
    render(<StorageUsageCard />);

    expect(
      JSON.parse(screen.getByTestId("chart").getAttribute("data-balances") ?? ""),
    ).toEqual([]);
  });
});

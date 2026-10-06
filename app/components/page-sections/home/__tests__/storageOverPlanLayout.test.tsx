import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const overview = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@/app/lib/hooks/api/useStorageOverview", () => ({
  useStorageOverview: () => ({
    data: overview.current,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

import StorageOverviewCard from "../storage-overview";

const base = {
  source: "free",
  usedPending: false,
  usedBytes: 627_820_000_000,
  usedDisplay: "627.82 GB",
  totalDisplay: "10.00 GB",
  freeDisplay: "0.00 GB",
  plan: null,
};

// An account far over its free allowance reads "617.82 GB over your plan"
// where a healthy one reads "45%". On one fixed row the sentence squeezed the
// figure onto two lines and ran into "of 10.00 GB used".
describe("the storage card over its plan", () => {
  it("lets the row wrap and never breaks the figure", () => {
    overview.current = { ...base, percent: 100, overDisplay: "617.82 GB over your plan" };
    render(<StorageOverviewCard />);
    expect(screen.getByTestId("storage-usage-row")).toHaveClass("flex-wrap");
    expect(screen.getByText("627.82 GB")).toHaveClass("whitespace-nowrap");
  });

  it("sets the over-plan sentence smaller than the figure, on the right", () => {
    overview.current = { ...base, percent: 100, overDisplay: "617.82 GB over your plan" };
    render(<StorageOverviewCard />);
    const aside = screen.getByTestId("storage-usage-aside");
    expect(aside).toHaveTextContent("617.82 GB over your plan");
    expect(aside).toHaveClass("text-[14px]", "ml-auto", "whitespace-nowrap");
    expect(aside).not.toHaveClass("text-[24px]");
  });

  it("keeps the percent at the figure's size when within the plan", () => {
    overview.current = { ...base, usedDisplay: "4.50 GB", freeDisplay: "5.50 GB", percent: 45, overDisplay: null };
    render(<StorageOverviewCard />);
    const aside = screen.getByTestId("storage-usage-aside");
    expect(aside).toHaveClass("text-[24px]");
    expect(aside).not.toHaveClass("text-[14px]");
  });
});

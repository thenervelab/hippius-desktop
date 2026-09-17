// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import BreakdownCard, {
  barOffsets,
  sharePercent,
  type BreakdownSlice,
} from "../BreakdownCard";

const slices: BreakdownSlice[] = [
  { key: "images", label: "Images", count: 25132, color: "#F34E5E" },
  { key: "videos", label: "Videos", count: 2357, color: "#7CD4F5" },
  { key: "docs", label: "Docs", count: 1363, color: "#3066DD" },
  {
    key: "others",
    label: "Others",
    count: 437230,
    color: "#9A9A9A",
    note: "(before tracking)",
  },
];

const renderCard = () =>
  render(
    <BreakdownCard
      title="Drive file types"
      icon={null}
      slices={slices}
      emptyText="nothing yet"
    />,
  );

const barsFor = (key: string) =>
  document.querySelectorAll(`[data-slice="${key}"]`);

describe("sharePercent", () => {
  it("rounds to whole percent", () => {
    expect(sharePercent(25, 100)).toBe("25%");
  });

  // A slice with files in it exists; saying "0%" contradicts the bar the
  // reader is pointing at.
  it("never rounds a non-empty slice down to nothing", () => {
    expect(sharePercent(1, 100000)).toBe("<1%");
  });

  it("reports nothing when there is nothing to divide", () => {
    expect(sharePercent(0, 100)).toBeNull();
    expect(sharePercent(5, 0)).toBeNull();
  });
});

describe("barOffsets", () => {
  // The tooltip anchors over the hovered slice's own run, so it needs where
  // each run starts, not just how long it is.
  it("gives each run its starting index", () => {
    expect(barOffsets([3, 1, 1, 30])).toEqual([0, 3, 4, 5]);
  });

  it("handles an empty run without shifting the ones after it", () => {
    expect(barOffsets([2, 0, 4])).toEqual([0, 2, 2]);
  });
});

describe("BreakdownCard hover", () => {
  it("says nothing until a bar is hovered", () => {
    renderCard();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the slice, its count and its share when hovered", () => {
    renderCard();
    fireEvent.mouseEnter(barsFor("images")[0]);

    const tip = screen.getByRole("status");
    expect(tip).toHaveTextContent("Images");
    expect(tip).toHaveTextContent("25,132");
    // 25132 of 466082 is 5%.
    expect(tip).toHaveTextContent("5%");
  });

  it("carries the bucket's caveat into the tooltip", () => {
    renderCard();
    fireEvent.mouseEnter(barsFor("others")[0]);
    expect(screen.getByRole("status")).toHaveTextContent("(before tracking)");
  });

  it("dims the other slices so the hovered run reads as one segment", () => {
    renderCard();
    fireEvent.mouseEnter(barsFor("images")[0]);

    expect(barsFor("images")[0].className).not.toMatch(/opacity-40/);
    expect(barsFor("others")[0].className).toMatch(/opacity-40/);
  });

  it("clears when the pointer leaves the chart", () => {
    const { container } = renderCard();
    fireEvent.mouseEnter(barsFor("images")[0]);
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.mouseLeave(container.querySelector(".relative")!);
    expect(screen.queryByRole("status")).toBeNull();
  });

  // The bar row is a single `role="img"`, so the bars are not reachable by
  // keyboard. The legend is what makes the same information available.
  it("opens from the legend on focus, for keyboard users", () => {
    renderCard();
    const legendEntry = screen.getByText("Videos").closest("[tabindex]")!;
    fireEvent.focus(legendEntry);

    expect(screen.getByRole("status")).toHaveTextContent("Videos");
  });
});

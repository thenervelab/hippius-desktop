import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { PageBars, tallestIndex } from "../PageBars";
import { RetentionChart } from "../RetentionChart";

const MS = [17_000, 0, 4_000, 9_000];
const label = (i: number) => `Page ${i + 1}`;
const valueText = (i: number) => (MS[i] > 0 ? `0:${String(MS[i] / 1000).padStart(2, "0")}` : "not seen");

function bars() {
  return render(<PageBars values={MS} label={label} valueText={valueText} listLabel="Time per page" summary="Time per page." />);
}

describe("the panel's charts", () => {
  it("finds the tallest bar, and none when nothing was counted", () => {
    expect(tallestIndex(MS)).toBe(0);
    expect(tallestIndex([0, 0])).toBeNull();
    expect(tallestIndex([3, 5, 5])).toBe(1);
  });

  it("labels only the tallest bar, and lists every page for a screen reader", () => {
    bars();
    expect(screen.getAllByTestId("chart-max-value")).toHaveLength(1);
    expect(screen.getByTestId("chart-max-value")).toHaveTextContent("0:17");
    const pages = within(screen.getByRole("list", { name: "Time per page" })).getAllByRole("listitem");
    expect(pages.map((p) => p.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Page 1, 0:17"), expect.stringContaining("Page 2, not seen")]),
    );
    // A page nobody saw is a sliver on the baseline, not a bar.
    expect(screen.getAllByTestId("page-bar")[1].className).toContain("h-[2px]");
    expect(screen.getAllByTestId("page-bar")[0].className).toContain("rounded-t-");
  });

  it("reads the exact value on hover, and on the arrow keys", () => {
    bars();
    const chart = screen.getByRole("group", { name: /Time per page\. Use the arrow keys/ });
    fireEvent.pointerEnter(within(chart).getAllByRole("listitem")[2]);
    expect(within(chart).getByText("Page 3 · 0:04")).toBeInTheDocument();

    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    // Focus starts on the tallest page; one step right is page 2.
    expect(screen.getAllByText("Page 2 · not seen").length).toBeGreaterThan(0);
    fireEvent.keyDown(chart, { key: "End" });
    expect(screen.getAllByText("Page 4 · 0:09").length).toBeGreaterThan(0);
  });

  it("draws the retention curve with one baseline and its end value, no labelled gridlines", () => {
    render(<RetentionChart values={[100, 80, 60]} durationMs={null} endLabels={["Page 1", "Page 3"]} />);
    expect(screen.getByTestId("chart-end-value")).toHaveTextContent("60%");
    expect(screen.queryByText("50%")).toBeNull();
    expect(screen.queryByText("100%")).toBeNull();
    expect(document.querySelector(".font-mono")).toBeNull();
    expect(document.querySelector("linearGradient")).toBeNull();
  });
});

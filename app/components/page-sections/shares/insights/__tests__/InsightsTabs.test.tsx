import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";

import { InsightsTabs, type InsightsTabItem } from "../InsightsTabs";
import type { InsightsTab } from "../insightsView";

const FIVE: InsightsTabItem[] = [
  { key: "comments", label: "Comments", count: 12 },
  { key: "viewers", label: "Viewers", count: 3 },
  { key: "pages", label: "Pages", count: null },
  { key: "reactions", label: "Reactions", count: 0 },
  { key: "nda", label: "NDA", count: 4 },
];

function Harness({ onChange }: { onChange?: (t: InsightsTab) => void }) {
  const [active, setActive] = useState<InsightsTab>("comments");
  return (
    <InsightsTabs
      idBase="t"
      tabs={FIVE}
      active={active}
      onChange={(t) => {
        setActive(t);
        onChange?.(t);
      }}
    />
  );
}

describe("InsightsTabs", () => {
  it("holds five tabs, each named by its label and count, in one row that scrolls rather than clips", () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Comments 12", "Viewers 3", "Pages", "Reactions 0", "NDA 4"]);
    expect(screen.getByRole("tab", { name: "Comments 12" })).toHaveAttribute("aria-selected", "true");
    // Every tab keeps its full words: no truncation, no shrinking.
    for (const tab of tabs) expect(tab.className).toMatch(/shrink-0/);
    for (const tab of tabs) expect(tab.className).toMatch(/whitespace-nowrap/);
    expect(screen.getByRole("tablist", { name: "Insights" }).className).toMatch(/overflow-x-auto/);
  });

  it("points each tab at its panel and is one tab stop", () => {
    render(<Harness />);
    const nda = screen.getByRole("tab", { name: "NDA 4" });
    expect(nda).toHaveAttribute("id", "t-tab-nda");
    expect(nda).toHaveAttribute("aria-controls", "t-panel-nda");
    expect(screen.getAllByRole("tab").filter((t) => t.tabIndex === 0)).toHaveLength(1);
  });

  it("moves selection and focus with the arrow keys, Home and End", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("nda");
    expect(screen.getByRole("tab", { name: "NDA 4" })).toHaveFocus();
    fireEvent.keyDown(list, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("comments");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Viewers 3" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Pages" }));
    expect(onChange).toHaveBeenLastCalledWith("pages");
  });
});

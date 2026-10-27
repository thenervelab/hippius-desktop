// `UnderlineTabs`: the WAI-ARIA tabs pattern (roles, one tab stop, arrows
// that wrap, Home/End, automatic activation), counts in the accessible name,
// short labels that never change what a screen reader hears, and the look
// the console's version has (brand colour and underline on the active tab,
// muted others).

import React, { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

import UnderlineTabs, { type UnderlineTab } from "../tabs/UnderlineTabs";

type Key = "all" | "with-you" | "by-you";
const TABS: UnderlineTab<Key>[] = [
  { key: "all", label: "All", count: 5 },
  { key: "with-you", label: "Shared with you", shortLabel: "With you", count: 3 },
  { key: "by-you", label: "Shared by you", shortLabel: "By you", count: 2 },
];

function Harness({ onChange, ...rest }: { onChange?: (k: Key) => void; idBase?: string; trailing?: React.ReactNode }) {
  const [value, setValue] = useState<Key>("all");
  return (
    <UnderlineTabs
      ariaLabel="Filter shared drives"
      tabs={TABS}
      value={value}
      onChange={(k) => {
        setValue(k);
        onChange?.(k);
      }}
      {...rest}
    />
  );
}

const tabs = () => within(screen.getByRole("tablist", { name: "Filter shared drives" })).getAllByRole("tab");

describe("UnderlineTabs", () => {
  it("names each tab by its full label and count", () => {
    render(<Harness />);
    expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual([
      "All (5)",
      "Shared with you (3)",
      "Shared by you (2)",
    ]);
  });

  it("draws the short label and the full one, switched by the content column's width", () => {
    render(<Harness />);
    const withYou = tabs()[1]!;
    // Both weights render, so each label appears twice (one is invisible).
    const short = within(withYou).getAllByText("With you")[0]!;
    const full = within(withYou).getAllByText("Shared with you")[0]!;
    expect(short).toHaveClass("@2xl:hidden");
    expect(full).toHaveClass("hidden", "@2xl:inline");
    // The count pill is decoration; the name already says it.
    expect(within(withYou).getByText("3")).toHaveAttribute("aria-hidden", "true");
  });

  it("is one tab stop, on the selected tab", () => {
    render(<Harness />);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("selects on click without moving focus", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(tabs()[2]!);
    expect(onChange).toHaveBeenCalledWith("by-you");
    expect(tabs()[2]).toHaveAttribute("aria-selected", "true");
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("moves focus and selection together with the arrows, wrapping at the ends", () => {
    render(<Harness />);
    fireEvent.keyDown(tabs()[0]!, { key: "ArrowLeft" });
    expect(tabs()[2]).toHaveAttribute("aria-selected", "true");
    expect(tabs()[2]).toHaveFocus();
    fireEvent.keyDown(tabs()[2]!, { key: "ArrowRight" });
    expect(tabs()[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs()[0]).toHaveFocus();
  });

  it("jumps to the first and last tab with Home and End", () => {
    render(<Harness />);
    fireEvent.keyDown(tabs()[0]!, { key: "End" });
    expect(tabs()[2]).toHaveFocus();
    fireEvent.keyDown(tabs()[2]!, { key: "Home" });
    expect(tabs()[0]).toHaveFocus();
  });

  it("ignores other keys", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(tabs()[0]!, { key: "ArrowDown" });
    fireEvent.keyDown(tabs()[0]!, { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks the active tab in the brand colour with an underline, and mutes the others", () => {
    render(<Harness />);
    const [on, off] = tabs();
    expect(on).toHaveClass("text-primary-50", "after:bg-primary-50", "dark:text-primary-brand-dark");
    expect(off).toHaveClass("text-grey-60", "after:bg-transparent");
    expect(on).toHaveClass("after:h-0.5");
  });

  it("points each tab at its panel only when there is one", () => {
    const { unmount } = render(<Harness />);
    expect(tabs()[0]).not.toHaveAttribute("aria-controls");
    unmount();
    render(<Harness idBase="shared" />);
    expect(tabs()[1]).toHaveAttribute("id", "shared-tab-with-you");
    expect(tabs()[1]).toHaveAttribute("aria-controls", "shared-panel-with-you");
  });

  it("renders trailing content outside the tablist", () => {
    render(<Harness trailing={<span>Total size: 7 GB</span>} />);
    const trailing = screen.getByText("Total size: 7 GB");
    expect(screen.getByRole("tablist")).not.toContainElement(trailing);
  });
});

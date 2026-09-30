// `TabList` with an `idBase` is real tabs over `TabPanel`s: one tab stop,
// arrow keys, Home and End, ids tying each tab to its panel, and a hidden
// panel that is really hidden even when laid out with `flex`. Without an
// `idBase` it stays the plain switcher every other screen uses.

import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";

import TabList from "@/components/ui/tabs/TabList";
import TabPanel from "@/components/ui/tabs/TabPanel";

const TABS = [
  { tabName: "One", tabKey: "one" },
  { tabName: "Two", tabKey: "two" },
  { tabName: "Three", tabKey: "three" },
];

function Harness() {
  const [tab, setTab] = useState("one");
  return (
    <>
      <TabList idBase="t" ariaLabel="Pick one" tabs={TABS} activeTab={tab} onTabChange={setTab} />
      {TABS.map(({ tabKey }) => (
        <TabPanel key={tabKey} idBase="t" tabKey={tabKey} activeTab={tab} className="flex flex-col">
          <input aria-label={`field ${tabKey}`} />
        </TabPanel>
      ))}
    </>
  );
}

describe("accessible TabList", () => {
  it("is a named tablist whose tabs control their panels", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Pick one" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["One", "Two", "Three"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("aria-controls", "t-panel-one");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "t-panel-one");
    expect(panel).toHaveAttribute("aria-labelledby", "t-tab-one");
  });

  it("is one tab stop, the selected tab", () => {
    render(<Harness />);
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves focus and selection with the arrows, Home and End, wrapping at the ends", () => {
    render(<Harness />);
    const tab = (name: string) => screen.getByRole("tab", { name });
    tab("One").focus();
    fireEvent.keyDown(tab("One"), { key: "ArrowRight" });
    expect(tab("Two")).toHaveFocus();
    expect(tab("Two")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab("Two"), { key: "End" });
    expect(tab("Three")).toHaveFocus();
    fireEvent.keyDown(tab("Three"), { key: "ArrowRight" });
    expect(tab("One")).toHaveFocus();
    fireEvent.keyDown(tab("One"), { key: "ArrowLeft" });
    expect(tab("Three")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab("Three"), { key: "Home" });
    expect(tab("One")).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it("keeps every panel mounted but really hides the inactive ones", () => {
    render(<Harness />);
    const two = screen.getByLabelText("field two").parentElement!;
    expect(two).toHaveAttribute("hidden");
    // The flex layout must not beat [hidden]: the class goes too.
    expect(two.className.split(/\s+/)).toContain("hidden");
    expect(two.className.split(/\s+/)).not.toContain("flex");
    fireEvent.click(screen.getByRole("tab", { name: "Two" }));
    expect(two).not.toHaveAttribute("hidden");
    expect(two.className.split(/\s+/)).toContain("flex");
  });

  it("stays a plain switcher without an idBase", () => {
    render(<TabList tabs={TABS} activeTab="one" onTabChange={() => {}} />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import BreakdownCard, { type BreakdownSlice } from "../BreakdownCard";

const SLICES: BreakdownSlice[] = [
  { key: "images", label: "Images", count: 25121, color: "#F34E5E" },
  { key: "videos", label: "Videos", count: 2357, color: "#7CD4F5" },
  { key: "docs", label: "Docs", count: 1333, color: "#3066DD" },
  { key: "others", label: "Others", count: 425667, color: "#9A9A9A" },
];

function renderCard(over: Partial<React.ComponentProps<typeof BreakdownCard>> = {}) {
  return render(
    <BreakdownCard
      title="Drive file types"
      icon={<svg data-testid="product-icon" className="size-[14px]" />}
      slices={SLICES}
      emptyText="nothing yet"
      {...over}
    />,
  );
}

describe("the breakdown card header", () => {
  // The regression this pins: a sizeless SVG in the header expanded to its
  // own default box, drew as oversized circles AND pushed the title to the
  // right edge. Any icon here must carry an explicit size.
  it("renders no unsized svg", () => {
    const { container } = renderCard();
    const header = container.querySelector("div") as HTMLElement;
    for (const svg of Array.from(header.querySelectorAll("svg"))) {
      const cls = svg.getAttribute("class") ?? "";
      expect(cls).toMatch(/size-|h-|w-/);
    }
  });

  it("puts the title at the start of the header, after its icon", () => {
    const { container } = renderCard();
    const header = container.querySelector("div") as HTMLElement;
    const icon = within(header).getByTestId("product-icon");
    const title = within(header).getByText("Drive file types");
    // Icon first, then the title, and nothing between them pushing it over.
    expect(
      icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("lists every bucket with its count", () => {
    renderCard();
    expect(screen.getByText("Images")).toBeInTheDocument();
    expect(screen.getByText("25,121")).toBeInTheDocument();
    expect(screen.getByText("425,667")).toBeInTheDocument();
  });

  it("says so when there is nothing rather than drawing an empty chart", () => {
    renderCard({ slices: SLICES.map((s) => ({ ...s, count: 0 })) });
    expect(screen.getByText("nothing yet")).toBeInTheDocument();
  });

  it("reports the breakdown to a screen reader", () => {
    renderCard();
    expect(
      screen.getByRole("img", { name: /Drive file types: Images 25121/ }),
    ).toBeInTheDocument();
  });
});

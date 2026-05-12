import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import FilterChips from "../filter-chips";
import type { ActiveFilter } from "../filter-chips";

describe("FilterChips", () => {
  it("applies moe chip styling to active filters", () => {
    const filters: ActiveFilter[] = [
      {
        type: "date",
        value: "last7days",
        label: "Date",
        displayValue: "Last 7 days",
      },
    ];

    render(<FilterChips filters={filters} onRemoveFilter={vi.fn()} />);

    const label = screen.getByText("Date");
    const chip = label.closest("div");
    const closeButton = screen.getByRole("button");

    expect(chip).not.toBeNull();
    if (!chip) return;

    expect(chip).toHaveClass("rounded-[4.364px]");
    expect(chip).toHaveClass("border-[0.727px]");
    expect(chip).toHaveClass("bg-grey-light-700");
    expect(chip).toHaveClass("font-mono");
    expect(chip).toHaveClass("uppercase");
    expect(closeButton).toHaveClass("bg-grey-light-100");
    expect(closeButton).toHaveClass("rounded-[3px]");
  });
});

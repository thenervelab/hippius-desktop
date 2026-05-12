import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import FilterPills from "../FilterPills";

describe("FilterPills", () => {
  it("uses moe pill styling for filter triggers", () => {
    render(
      <FilterPills
        selectedFileTypes={[]}
        selectedDate=""
        selectedFileSizes={[]}
        onFileTypesChange={vi.fn()}
        onDateChange={vi.fn()}
        onFileSizesChange={vi.fn()}
      />,
    );

    const buttons = [
      screen.getByRole("button", { name: /file type/i }),
      screen.getByRole("button", { name: /^size$/i }),
      screen.getByRole("button", { name: /^date$/i }),
    ];

    for (const button of buttons) {
      expect(button).toHaveClass("rounded-[7px]");
      expect(button).toHaveClass("bg-[#fefefe]");
      expect(button).toHaveClass("border-[#e0e0e0]");
      expect(button).toHaveClass("font-mono");
      expect(button).toHaveClass("uppercase");
    }
  });
});

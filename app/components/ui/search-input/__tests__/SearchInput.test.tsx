import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import SearchInput from "../index";

vi.mock("@/components/ui", () => ({
  Icons: {
    Search: ({ className }: { className?: string }) => (
      <span data-testid="icon-search" className={className} />
    ),
    Close: ({ className }: { className?: string }) => (
      <span data-testid="icon-close" className={className} />
    ),
  },
}));

describe("SearchInput", () => {
  it("shows a clear button when there is a value", () => {
    render(<SearchInput value="hello" onChange={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /clear search/i }),
    ).toBeInTheDocument();
  });

  it("clears the value when the clear button is clicked", () => {
    const onChange = vi.fn();

    render(<SearchInput value="hello" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /clear search/i }));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("hides the clear button when empty", () => {
    render(<SearchInput value="" onChange={vi.fn()} />);

    expect(
      screen.queryByRole("button", { name: /clear search/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the slash shortcut pill when empty", () => {
    render(<SearchInput value="" onChange={vi.fn()} />);

    expect(screen.getByText("/")).toBeInTheDocument();
  });
});

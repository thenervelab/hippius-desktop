import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import TrayLinkActivity from "../TrayLinkActivity";

const EVENTS = [
  { id: 2, shareToken: null, line: "5 new views on 4 links", at: Date.now() - 60_000 },
  { id: 1, shareToken: "tok", line: "3 new views on deck.pdf", at: Date.now() - 12 * 60_000 },
];

describe("the tray's Link activity block", () => {
  it("draws nothing without events", () => {
    const { container } = render(<TrayLinkActivity events={[]} onOpen={vi.fn()} onSeeAll={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each event and opens its link, or Shared Links for many", () => {
    const onOpen = vi.fn();
    const onSeeAll = vi.fn();
    render(<TrayLinkActivity events={EVENTS} onOpen={onOpen} onSeeAll={onSeeAll} />);
    expect(screen.getByRole("heading", { name: "Link activity" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /3 new views on deck\.pdf/ }));
    expect(onOpen).toHaveBeenLastCalledWith("tok");
    fireEvent.click(screen.getByRole("button", { name: /5 new views on 4 links/ }));
    expect(onOpen).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "See all" }));
    expect(onSeeAll).toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import AccountLabel from "../AccountLabel";

const SS58 = "5CV9U6cccccccccccccccccccccccccccccccccccccccccMFXb";

describe("AccountLabel", () => {
  it("shows the name in the body font when the server sent one", () => {
    render(<AccountLabel ss58={SS58} name="Grace Hopper" email="grace@example.com" />);
    const label = screen.getByText("Grace Hopper");
    expect(label.getAttribute("data-ss58")).toBe(SS58);
    expect(label.className).not.toContain("font-mono");
    // The email is hover-only: never drawn inline where a row has no room.
    expect(screen.queryByText("grace@example.com")).toBeNull();
  });

  it("falls back to the shortened ss58 in mono when the name is absent", () => {
    render(<AccountLabel ss58={SS58} />);
    const label = screen.getByText((_, el) => el?.getAttribute("data-ss58") === SS58);
    expect(label.textContent).toContain("…");
    expect(label.className).toContain("font-mono");
  });

  it("keeps a prefix inside the same hover target", () => {
    render(<AccountLabel ss58={SS58} name="Ada" prefix="Created by " />);
    expect(screen.getByText("Created by Ada")).toBeInTheDocument();
  });
});

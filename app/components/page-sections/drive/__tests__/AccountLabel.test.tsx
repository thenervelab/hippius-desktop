// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import AccountLabel from "../AccountLabel";

const SS58 = "5CV9U6cccccccccccccccccccccccccccccccccccccccccMFXb";

const labelOf = (container: HTMLElement) => container.querySelector<HTMLElement>(`[data-ss58="${SS58}"]`)!;

describe("AccountLabel", () => {
  it("shows the name in the body font when the server sent one", () => {
    const { container } = render(<AccountLabel ss58={SS58} name="Grace Hopper" email="grace@example.com" />);
    const label = labelOf(container);
    expect(label.className).not.toContain("font-mono");
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    // The email is hover-only: never drawn inline where a row has no room.
    expect(screen.queryByText("grace@example.com")).toBeNull();
  });

  // The whole address goes to the line, which shortens it in the middle to
  // the width it has. A pre-shortened address cut again by CSS at its end
  // was the "5DSQAMf3JVb3V…5…" double cut.
  it("hands the whole ss58 to a middle-shortening line, in mono, when the name is absent", () => {
    const { container } = render(<AccountLabel ss58={SS58} />);
    const label = labelOf(container);
    expect(label.className).toContain("font-mono");
    expect(label.querySelector("[data-middle-truncate]")).not.toBeNull();
    // No layout in a test DOM, so nothing is cut here; the fit itself is
    // covered by the MiddleTruncate and fitMiddle tests.
    expect(label.querySelector("[data-middle-truncate]")!.getAttribute("title")).toBeNull();
  });

  it("never cuts the label at its end", () => {
    const { container } = render(<AccountLabel ss58={SS58} name="Grace Hopper" focusable />);
    for (const el of container.querySelectorAll<HTMLElement>("*")) {
      expect(el.className).not.toMatch(/\btruncate\b/);
    }
  });

  it("keeps a prefix inside the same hover target, outside the shortened part", () => {
    const { container } = render(<AccountLabel ss58={SS58} name="Ada" prefix="Created by " />);
    const label = labelOf(container);
    expect(label.textContent?.startsWith("Created by ")).toBe(true);
    const line = label.querySelector("[data-middle-truncate]")!;
    expect(line.textContent).not.toContain("Created by");
  });
});

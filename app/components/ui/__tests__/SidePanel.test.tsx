import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";
import { MotionGlobalConfig } from "framer-motion";

import { SidePanel, clampPanelWidth, maxPanelWidth, resolveOpener, RESIZE_STEP_PX } from "../SidePanel";

vi.mock("@/app/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks")>();
  return {
    ...actual,
    useBreakpoint: () => ({
      breakpoint: "xl",
      isMobile: false,
      isTablet: false,
      isLaptop: false,
      isDesktop: true,
      isLargeDesktop: false,
    }),
  };
});
MotionGlobalConfig.skipAnimations = true;

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("resolveOpener", () => {
  it("stands a menu's trigger in for the menu item that opened the panel", () => {
    document.body.innerHTML = `
      <button id="trigger">Row actions</button>
      <div role="menu" aria-labelledby="trigger"><div role="menuitem" tabindex="-1" id="item">Insights</div></div>`;
    expect(resolveOpener(document.getElementById("item"))).toBe(document.getElementById("trigger"));
  });

  it("keeps a plain button, and has nothing for the page itself", () => {
    document.body.innerHTML = `<button id="b">Insights</button>`;
    expect(resolveOpener(document.getElementById("b"))).toBe(document.getElementById("b"));
    expect(resolveOpener(document.body)).toBeNull();
    expect(resolveOpener(null)).toBeNull();
  });
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Menu trigger</button>
      <SidePanel open={open} onClose={() => setOpen(false)} width={320} label="Details">
        <h2 tabIndex={-1} data-panel-autofocus>
          Details
        </h2>
        <button type="button">Inside</button>
      </SidePanel>
    </>
  );
}

describe("SidePanel", () => {
  it("takes focus back once when a closing menu hands it to its trigger, until the user acts", async () => {
    render(<Harness />);
    const open = screen.getByRole("button", { name: "Open" });
    open.focus();
    fireEvent.click(open);
    const heading = await screen.findByRole("heading", { name: "Details" });
    await waitFor(() => expect(heading).toHaveFocus());

    // A row menu finishing its close animation focuses its trigger.
    screen.getByRole("button", { name: "Menu trigger" }).focus();
    expect(heading).toHaveFocus();

    // Once the user presses a key or clicks, focus goes where they put it.
    fireEvent.keyDown(document, { key: "Tab" });
    screen.getByRole("button", { name: "Menu trigger" }).focus();
    expect(screen.getByRole("button", { name: "Menu trigger" })).toHaveFocus();
  });

  it("closes on Escape and gives focus back to what opened it", async () => {
    render(<Harness />);
    const open = screen.getByRole("button", { name: "Open" });
    open.focus();
    fireEvent.click(open);
    await screen.findByRole("complementary", { name: "Details" });
    fireEvent.keyDown(screen.getByRole("heading", { name: "Details" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    // Focus goes back as the panel's effects are cleaned up, which React does just after the panel leaves the page.
    await waitFor(() => expect(open).toHaveFocus());
  });
});

describe("a resizable panel", () => {
  const KEY = "test:panel-width";
  function Resizable({ width = 440 }: { width?: number }) {
    return (
      <SidePanel open onClose={() => {}} width={width} label="Insights" resizable={{ storageKey: KEY }}>
        <p>Body</p>
      </SidePanel>
    );
  }
  const columnWidth = () => screen.getByText("Body").parentElement!.style.width;

  it("is never narrower than its width, nor wider than about two thirds of the window", () => {
    expect(maxPanelWidth(440, 1600)).toBe(1040);
    // A window too small for more keeps today's width.
    expect(maxPanelWidth(440, 600)).toBe(440);
    expect(clampPanelWidth(300, 440, 1600)).toBe(440);
    expect(clampPanelWidth(5000, 440, 1600)).toBe(1040);
  });

  it("widens to the left from the keyboard, remembers it, and a double click puts it back", () => {
    window.innerWidth = 1600;
    const { unmount } = render(<Resizable />);
    const edge = screen.getByRole("separator", { name: "Resize Insights" });
    expect(edge).toHaveAttribute("aria-orientation", "vertical");
    expect(edge).toHaveAttribute("aria-valuemin", "440");
    expect(edge).toHaveAttribute("aria-valuemax", "1040");
    expect(columnWidth()).toBe("440px");

    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(edge).toHaveAttribute("aria-valuenow", String(440 + RESIZE_STEP_PX));
    fireEvent.keyDown(edge, { key: "ArrowLeft", shiftKey: true });
    expect(columnWidth()).toBe(`${440 + RESIZE_STEP_PX * 5}px`);
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(edge).toHaveAttribute("aria-valuenow", String(440 + RESIZE_STEP_PX * 4));
    expect(window.localStorage.getItem(KEY)).toBe(String(440 + RESIZE_STEP_PX * 4));
    fireEvent.keyDown(edge, { key: "End" });
    expect(edge).toHaveAttribute("aria-valuenow", "1040");

    // Opened again, it comes back at the width chosen.
    unmount();
    render(<Resizable />);
    expect(columnWidth()).toBe("1040px");
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(columnWidth()).toBe("440px");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("follows the pointer dragged to the left", () => {
    // jsdom has no PointerEvent: a MouseEvent carries the button and position.
    if (!("PointerEvent" in window)) {
      Object.defineProperty(window, "PointerEvent", {
        configurable: true,
        value: class extends MouseEvent {
          pointerId: number;
          constructor(type: string, init: PointerEventInit = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 0;
          }
        },
      });
    }
    window.innerWidth = 1600;
    render(<Resizable />);
    const edge = screen.getByRole("separator");
    fireEvent.pointerDown(edge, { button: 0, clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 900, pointerId: 1 });
    expect(columnWidth()).toBe("540px");
    fireEvent.pointerUp(edge, { clientX: 880, pointerId: 1 });
    expect(columnWidth()).toBe("560px");
    expect(window.localStorage.getItem(KEY)).toBe("560");
  });

  it("holds a stored width inside a window that got smaller, and opens normally when storage throws", () => {
    window.localStorage.setItem(KEY, "1200");
    window.innerWidth = 1000;
    const { unmount } = render(<Resizable />);
    expect(columnWidth()).toBe("650px");
    unmount();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      render(<Resizable />);
      expect(columnWidth()).toBe("440px");
    } finally {
      get.mockRestore();
    }
  });

  // `<main>` keeps a 4px right margin; the panel takes it back so its left
  // edge, and the resize line drawn on it, sit on the content column's edge.
  it("starts exactly where the content column ends", () => {
    render(<Resizable />);
    const aside = screen.getByRole("complementary", { name: "Insights" });
    expect(aside.className).toMatch(/(^|\s)-ml-1(\s|$)/);
    expect(screen.getByRole("separator").className).toMatch(/(^|\s)left-0(\s|$)/);
  });

  it("has no edge to drag when it is not resizable", () => {
    render(
      <SidePanel open onClose={() => {}} width={320} label="Details">
        <p>Body</p>
      </SidePanel>,
    );
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

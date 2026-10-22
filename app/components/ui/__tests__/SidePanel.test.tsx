import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";
import { MotionGlobalConfig } from "framer-motion";

import { SidePanel, resolveOpener } from "../SidePanel";

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
    expect(open).toHaveFocus();
  });
});

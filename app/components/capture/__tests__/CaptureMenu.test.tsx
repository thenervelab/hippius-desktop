import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import CaptureMenu from "../CaptureMenu";
import { captureSupportedAtom } from "@/app/lib/capture/captureFlow";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(
      cmd === "capture_get_shortcut"
        ? { accelerator: "CommandOrControl+Shift+2", defaultAccelerator: "CommandOrControl+Shift+2" }
        : null,
    ),
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// Reachability given the feature is on; which lane it is on is pinned by
// the flag's own tests.
vi.mock("@/app/lib/featureFlags", () => ({ SCREEN_CAPTURE_ENABLED: true }));

function renderWith(supported: boolean) {
  const store = createStore();
  store.set(captureSupportedAtom, supported);
  return render(
    <Provider store={store}>
      <CaptureMenu />
    </Provider>,
  );
}

describe("CaptureMenu", () => {
  it("offers Capture where the platform can capture", () => {
    const { getByRole } = renderWith(true);
    expect(getByRole("button", { name: /capture/i })).toBeInTheDocument();
  });

  // Linux reports unsupported until its portal path lands: a menu whose every
  // item fails is worse than no menu.
  it("renders nothing where Rust says the platform cannot capture", () => {
    const { container } = renderWith(false);
    expect(container).toBeEmptyDOMElement();
  });
});


const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("CaptureMenu styling", () => {
  // The shared DropdownMenuContent's base is `bg-popover`, a token this theme
  // does not define, so a menu that adds no background of its own renders
  // with none — its items invisible in dark mode, which is how this shipped.
  it("gives the menu its own background in both themes", () => {
    const menu = src("app/components/capture/CaptureMenu.tsx");
    expect(menu).toMatch(/<DropdownMenuContent[^>]*className=\{CONTENT_CLASSES\}/);
    expect(menu).toMatch(/CONTENT_CLASSES = cn\([\s\S]*?"bg-white[\s\S]*?"dark:bg-/);
    expect(menu).toMatch(/ITEM_CLASSES = cn\([\s\S]*?dark:text-/);
  });
});

describe("where Capture is offered", () => {
  // The home header is also Billing's, Wallet's, Referrals' and Plans'. It
  // offers Capture only where asked, and only Overview asks.
  it("is opt-in on the shared home header, and only Overview opts in", () => {
    expect(src("app/components/page-sections/home/PageHeader.tsx")).toMatch(/\{showCapture && <CaptureMenu \/>\}/);
    expect(src("app/components/page-sections/home/index.tsx")).toMatch(/<PageHeader[^>]*showCapture/);
    for (const page of ["billing", "wallet", "referrals", "drive-plans"]) {
      expect(src(`app/components/page-sections/${page}/index.tsx`)).not.toContain("showCapture");
    }
  });
});

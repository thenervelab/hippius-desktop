import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

const nav = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), section: "sync" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, back: nav.back, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`section=${nav.section}`),
}));
const flags = vi.hoisted(() => ({ capture: true }));
vi.mock("@/app/lib/featureFlags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/featureFlags")>()),
  get SCREEN_CAPTURE_ENABLED() {
    return flags.capture;
  },
}));
// The search pill and the footer have their own tests and their own IPC.
vi.mock("../SidebarSearch", () => ({ default: () => null }));
vi.mock("../SidebarFooter", () => ({ default: () => null }));

import SettingsSidebar from "../SettingsSidebar";
import { captureSupportedAtom } from "@/app/lib/capture/captureFlow";

function renderSidebar(supported: boolean) {
  const store = createStore();
  store.set(captureSupportedAtom, supported);
  return render(
    <Provider store={store}>
      <SettingsSidebar />
    </Provider>,
  );
}

const entries = () =>
  screen
    .getAllByRole("button")
    .map((b) => b.textContent?.trim())
    .filter((t): t is string => !!t && t !== "Go Back");

beforeEach(() => {
  nav.replace.mockClear();
  nav.section = "sync";
  flags.capture = true;
});

describe("the settings sidebar's Screenshots & Recording tab", () => {
  it("sits right after Sync & Storage where capture works, and opens its section", () => {
    renderSidebar(true);
    const labels = entries();
    expect(labels.indexOf("Screenshots & Recording")).toBe(labels.indexOf("Sync & Storage") + 1);
    fireEvent.click(screen.getByRole("button", { name: "Screenshots & Recording" }));
    expect(nav.replace).toHaveBeenCalledWith("/settings?section=capture");
  });

  it("is absent where this computer cannot capture", () => {
    renderSidebar(false);
    expect(entries()).not.toContain("Screenshots & Recording");
    expect(entries()).toContain("Sync & Storage");
  });

  it("is absent where the lane has capture off", () => {
    flags.capture = false;
    renderSidebar(true);
    expect(entries()).not.toContain("Screenshots & Recording");
  });

  it("marks itself as the open section", () => {
    nav.section = "capture";
    renderSidebar(true);
    const label = screen.getByText("Screenshots & Recording");
    expect(label.className).toContain("text-[#0a0a0a]");
  });
});

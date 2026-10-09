// A production build carries screen capture on every platform
// (`SCREEN_CAPTURE_ENABLED` is not mocked here, and Vitest builds as
// production), but Rust's `capture_support` turns it on for macOS only. Every
// capture surface must follow Rust's answer, or Windows and Linux users get
// entries that do nothing, and must not act on the placeholder `false` the
// support atom holds before Rust has answered.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: "/files", section: "capture" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, back: vi.fn(), push: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(`section=${nav.section}`),
}));
vi.mock("react-intersection-observer", () => ({
  InView: ({ children }: { children: (v: { ref: () => void; inView: boolean }) => ReactNode }) =>
    children({ ref: () => undefined, inView: true }),
}));
// The sidebar's search pill and footer have their own tests and IPC.
vi.mock("@/app/components/sidebar/SidebarSearch", () => ({ default: () => null }));
vi.mock("@/app/components/sidebar/SidebarFooter", () => ({ default: () => null }));
// The Captures page's content and every settings section but the gate.
vi.mock("@/components/page-sections/captures/CapturesView", () => ({ default: () => <p>captures view</p> }));
vi.mock("@/components/page-sections/settings/CaptureSettings", () => ({ default: () => <p>capture settings</p> }));
vi.mock("@/components/page-sections/settings/AppearanceSettings", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/ReleaseChannelSettings", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/MultiFolderSyncManager", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/DeviceNameSetting", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/FinderExtensionSetting", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/RecoveryPhraseSettings", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/WalletSettings", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/ApiTokenSection", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/VPNSettings", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/CustomizeRPC", () => ({ default: () => null }));
vi.mock("@/components/page-sections/settings/NotificationSection", () => ({ default: () => null }));
vi.mock("@/components/page-sections/billing/BillingSections", () => ({ default: () => null }));

import { BUILD_CHANNEL } from "@/app/lib/buildChannel";
import { SCREEN_CAPTURE_ENABLED } from "@/app/lib/featureFlags";
import { captureSupportedAtom, captureSupportKnownAtom } from "@/app/lib/capture/captureFlow";
import { captureAvailability, useCaptureAvailability } from "@/app/lib/capture/useCaptureAvailability";
import { offersImageEditor } from "@/app/lib/capture/editor/driveEntry";
import Sidebar from "@/app/components/sidebar";
import SettingsPage from "@/app/(pages)/settings/page";
import CapturesPage from "@/app/(pages)/captures/page";

/** Rust's answer: `undefined` = not answered yet. */
type Support = boolean | undefined;

function storeFor(support: Support) {
  const store = createStore();
  store.set(captureSupportKnownAtom, support !== undefined);
  store.set(captureSupportedAtom, support === true);
  return store;
}

function renderWith(ui: ReactNode, support: Support) {
  return render(<Provider store={storeFor(support)}>{ui}</Provider>);
}

beforeEach(() => {
  nav.replace.mockClear();
  nav.pathname = "/files";
  nav.section = "capture";
});

describe("a production build", () => {
  it("carries capture: the flag is on", () => {
    expect(BUILD_CHANNEL).toBe("production");
    expect(SCREEN_CAPTURE_ENABLED).toBe(true);
  });
});

describe("capture availability", () => {
  it("is unknown until Rust answers, then Rust's answer", () => {
    expect(captureAvailability(true, false, false)).toBe("unknown");
    expect(captureAvailability(true, true, false)).toBe("unavailable");
    expect(captureAvailability(true, true, true)).toBe("available");
  });

  it("is unavailable whatever Rust says when the build carries no capture", () => {
    expect(captureAvailability(false, false, false)).toBe("unavailable");
    expect(captureAvailability(false, true, true)).toBe("unavailable");
  });

  it("reads the support atoms CaptureHost sets", () => {
    const hook = (support: Support) =>
      renderHook(() => useCaptureAvailability(), {
        wrapper: ({ children }) => <Provider store={storeFor(support)}>{children}</Provider>,
      }).result.current;
    expect(hook(undefined)).toBe("unknown");
    expect(hook(false)).toBe("unavailable");
    expect(hook(true)).toBe("available");
  });
});

describe("the main sidebar's Captures entry", () => {
  // The label animates in letter by letter, so find the entry by its link.
  const link = (path: string) => document.querySelector(`a[href="${path}"]`);

  it("shows where this computer captures", () => {
    renderWith(<Sidebar />, true);
    expect(link("/captures")).not.toBeNull();
  });

  it("is absent where it cannot (Windows and Linux in production)", () => {
    renderWith(<Sidebar />, false);
    expect(link("/captures")).toBeNull();
    expect(link("/files")).not.toBeNull();
  });

  it("waits for Rust's answer rather than flashing in", () => {
    renderWith(<Sidebar />, undefined);
    expect(link("/captures")).toBeNull();
  });
});

describe("the Settings capture section", () => {
  const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

  it("shows where this computer captures", () => {
    renderWith(<SettingsPage />, true);
    expect(heading()).toBe("Screenshots & Recording");
    expect(screen.getByText("capture settings")).toBeInTheDocument();
  });

  it("falls back to Sync & Storage where it cannot", () => {
    renderWith(<SettingsPage />, false);
    expect(heading()).not.toBe("Screenshots & Recording");
    expect(screen.queryByText("capture settings")).not.toBeInTheDocument();
  });

  // Restored from the query string at launch, before Rust answers: a reset
  // then would throw a Mac that captures off its own section.
  it("is kept while Rust has not answered", () => {
    renderWith(<SettingsPage />, undefined);
    expect(heading()).toBe("Screenshots & Recording");
  });
});

describe("the Captures page", () => {
  it("renders where this computer captures", () => {
    renderWith(<CapturesPage />, true);
    expect(screen.getByText("captures view")).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("redirects home where it cannot", () => {
    renderWith(<CapturesPage />, false);
    expect(screen.queryByText("captures view")).not.toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith("/");
  });

  it("renders nothing and does not redirect while Rust has not answered", () => {
    renderWith(<CapturesPage />, undefined);
    expect(screen.queryByText("captures view")).not.toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe("the image editor entry", () => {
  const picture = {
    name: "Shot.png",
    isFolder: false,
    label: "Captures",
    cloudOnly: false,
    memberDrive: false,
  };

  it("is offered only where capture is available on this computer", () => {
    expect(offersImageEditor(picture, captureAvailability(SCREEN_CAPTURE_ENABLED, true, true) === "available")).toBe(true);
    expect(offersImageEditor(picture, captureAvailability(SCREEN_CAPTURE_ENABLED, true, false) === "available")).toBe(false);
    expect(offersImageEditor(picture, captureAvailability(SCREEN_CAPTURE_ENABLED, false, false) === "available")).toBe(
      false,
    );
  });
});

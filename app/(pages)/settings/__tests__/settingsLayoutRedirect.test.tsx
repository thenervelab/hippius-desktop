import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardPageHeaderAtom } from "@/components/dashboard-title-wrapper/dashboardAtoms";

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
// The sidebar has its own tests (and its own IPC); whether it is drawn at
// all is what matters here.
vi.mock("@/components/sidebar/SettingsSidebar", () => ({
  default: () => <nav data-testid="settings-sidebar" />,
}));

import SettingsLayout from "../layout";

function renderLayout(search: string) {
  nav.search = search;
  const store = createStore();
  render(
    <Provider store={store}>
      <SettingsLayout>
        <div data-testid="settings-page" />
      </SettingsLayout>
    </Provider>,
  );
  return store;
}

beforeEach(() => nav.replace.mockClear());

/**
 * Billing left Settings for a Plans & Billing page under the main sidebar.
 * `/settings?section=billing` is still out there: bookmarked, restored at
 * launch, and saved in low-credits notifications already in the database.
 */
describe("an old Settings billing link", () => {
  it("goes to Plans & Billing", () => {
    renderLayout("section=billing");
    expect(nav.replace).toHaveBeenCalledWith("/billing");
  });

  it("never draws Settings on the way there", () => {
    const store = renderLayout("section=billing");
    expect(screen.queryByTestId("settings-sidebar")).toBeNull();
    expect(screen.queryByTestId("settings-page")).toBeNull();
    expect(store.get(dashboardPageHeaderAtom).mainText).not.toBe("Settings");
  });
});

describe("a section still in Settings", () => {
  it.each(["section=sync", "section=security", ""])("stays in Settings (%j)", (search) => {
    const store = renderLayout(search);
    expect(nav.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    expect(store.get(dashboardPageHeaderAtom).mainText).toBe("Settings");
  });
});

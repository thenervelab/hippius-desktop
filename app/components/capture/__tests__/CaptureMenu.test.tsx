import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import CaptureMenu from "../CaptureMenu";
import { captureSupportedAtom } from "@/app/lib/capture/captureFlow";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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

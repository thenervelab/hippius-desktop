import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import RecordingLimitDialog from "../RecordingLimitDialog";
import { captureDialogAtom } from "@/app/lib/capture/captureFlow";
import { RECORDING_LIMIT_BODY, RECORDING_LIMIT_TITLE } from "@/app/lib/capture/recordingLimit";
import { BILLING_ROUTE, CAPTURES_ROUTE } from "@/app/lib/routes";

function mount(open = true) {
  const store = createStore();
  if (open) store.set(captureDialogAtom, { kind: "recordingLimit" });
  render(
    <Provider store={store}>
      <RecordingLimitDialog />
    </Provider>,
  );
  return store;
}

beforeEach(() => push.mockReset());

describe("the recording limit dialog", () => {
  it("says the free recordings are used up, and how to go on", () => {
    mount();
    expect(screen.getByText(RECORDING_LIMIT_TITLE)).toBeInTheDocument();
    expect(screen.getByText(RECORDING_LIMIT_BODY)).toBeInTheDocument();
    for (const name of ["Upgrade", "Open Captures", "Not now"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("is closed unless Rust refused a recording", () => {
    mount(false);
    expect(screen.queryByText(RECORDING_LIMIT_TITLE)).toBeNull();
  });

  it("Upgrade opens the plans and closes", async () => {
    const store = mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upgrade" })));
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
    expect(store.get(captureDialogAtom)).toBeNull();
  });

  it("Open Captures goes where an older recording can be deleted", async () => {
    mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Captures" })));
    expect(push).toHaveBeenCalledWith(CAPTURES_ROUTE);
  });

  it("Not now only closes", async () => {
    const store = mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Not now" })));
    expect(push).not.toHaveBeenCalled();
    expect(store.get(captureDialogAtom)).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";

import InsufficientCreditsDialog from "../InsufficientCreditsDialog";
import {
  insufficientCreditsDialogOpenAtom,
  InsufficientCreditsReason,
} from "../atoms/query-atoms";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: unknown[]) => push(...a) }),
}));

const openLinkByKey = vi.fn();
vi.mock("@/app/lib/utils/links", () => ({
  openLinkByKey: (...a: unknown[]) => openLinkByKey(...a),
}));

/** Every Drive action is gated on the plan allowance, so all of these must
 *  end up on the plans page. `vm-creation` is the one credit-priced action
 *  and is asserted separately. */
const DRIVE_REASONS: InsufficientCreditsReason[] = [
  "file-upload",
  "folder-upload",
  "folder-sync",
  "sharing",
];

function renderWithReason(reason: InsufficientCreditsReason) {
  const store = createStore();
  store.set(insufficientCreditsDialogOpenAtom, reason);
  render(
    <Provider store={store}>
      <InsufficientCreditsDialog />
    </Provider>,
  );
  return store;
}

describe("InsufficientCreditsDialog", () => {
  beforeEach(() => {
    push.mockReset();
    openLinkByKey.mockReset();
  });

  // The whole reason `StorageLimitReached` is a separate error kind is that
  // the way out is a bigger plan, not a topped-up balance. A Drive refusal
  // that offered credits would send the user somewhere that cannot help.
  it.each(DRIVE_REASONS)(
    "sends a %s refusal to the plans page and never offers credits",
    (reason) => {
      renderWithReason(reason);

      expect(screen.getByText("Not enough storage")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /buy credits/i })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /view plans/i }));
      expect(push).toHaveBeenCalledWith("/drive-plans");
      expect(openLinkByKey).not.toHaveBeenCalled();
    },
  );

  it("keeps VM creation on the credits route", () => {
    renderWithReason("vm-creation");

    expect(screen.getByText(/Insufficient Credits for VM Creation/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /buy credits/i }));
    expect(openLinkByKey).toHaveBeenCalledWith("CREDITS");
    expect(push).not.toHaveBeenCalled();
  });

  it("renders nothing while no refusal is pending", () => {
    const store = createStore();
    store.set(insufficientCreditsDialogOpenAtom, false);
    const { container } = render(
      <Provider store={store}>
        <InsufficientCreditsDialog />
      </Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

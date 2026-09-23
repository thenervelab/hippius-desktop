import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";

import InsufficientCreditsDialog from "../InsufficientCreditsDialog";
import { BILLING_ROUTE } from "@/app/lib/routes";
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

vi.mock("@/app/lib/hooks/api/useStorageOverview", () => ({
  useStorageOverview: () => ({ data: mockOverview }),
}));

let mockOverview: {
  source?: "subscription" | "free" | "none";
  overDisplay?: string | null;
} | undefined = { source: "subscription" };

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
    mockOverview = { source: "subscription" };
  });

  // The whole reason `StorageLimitReached` is a separate error kind is that
  // the way out is a bigger plan, not a topped-up balance. A Drive refusal
  // that offered credits would send the user somewhere that cannot help.
  it.each(DRIVE_REASONS)(
    "sends a %s refusal to Billing and never offers credits",
    (reason) => {
      renderWithReason(reason);

      expect(screen.getByText("Not enough storage")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /top up/i })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /upgrade/i }));
      expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
      expect(openLinkByKey).not.toHaveBeenCalled();
    },
  );

  it("asks an access-key account with no plan to Subscribe", () => {
    mockOverview = { source: "none" };
    renderWithReason("file-upload");

    expect(
      screen.getByText("You don't have a subscription plan"),
    ).toBeInTheDocument();
    expect(screen.getByText(/permanently deleted after/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /subscribe/i }));
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
  });

  // Share refusals use the same over-quota dialog as uploads: files stay,
  // uploads pause. The old share-only line read like a policy freeze.
  it("explains a share refusal with the shared over-quota copy", () => {
    mockOverview = {
      source: "subscription",
      overDisplay: "1.00 GB over your plan",
    };
    renderWithReason("sharing");

    expect(screen.getByText("You're over your plan's storage")).toBeInTheDocument();
    expect(
      screen.getByText(/Uploads are paused, your files stay available/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/new share links are paused/i)).not.toBeInTheDocument();
  });

  it("keeps VM creation on the credits route", () => {
    renderWithReason("vm-creation");

    expect(screen.getByText(/Not enough balance for VM creation/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /top up/i }));
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

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// The real container swallows clicks inside the card (`stopClickPropagation`)
// so they never reach the dialog's backdrop-close handler; the stub must do
// the same or a button click reads as a backdrop click too.
vi.mock("@/components/ui/BackgroundContainer", () => ({
  BackgroundContainer: ({
    children,
    stopClickPropagation,
  }: {
    children: React.ReactNode;
    stopClickPropagation?: boolean;
  }) => (
    <div
      onClick={stopClickPropagation ? (e) => e.stopPropagation() : undefined}
    >
      {children}
    </div>
  ),
}));
vi.mock("@/components/ui/ConfettiCanvas", () => ({ default: () => null }));
vi.mock("@/components/ui/PixelGridLoader", () => ({ default: () => null }));

import DrivePlanFlowDialog from "../DrivePlanFlowDialog";
import type { DrivePlan } from "@/lib/types/drive-plans";

const plan: DrivePlan = {
  code: "solo",
  name: "Starter",
  storage_bytes: 500 * 1024 * 1024 * 1024,
  price_credits_monthly: 4,
  price_credits_annual: 3.5,
  is_free: false,
};

const noop = () => {};

describe("DrivePlanFlowDialog", () => {
  // The card rail pays in the browser, where the app cannot see the
  // outcome. The old blocking "Processing…" had no way out when the user
  // abandoned Stripe; the browser stage must explain and be dismissible.
  it("shows a dismissible browser notice for a card checkout, not Processing", () => {
    const onDismiss = vi.fn();
    render(
      <DrivePlanFlowDialog
        flow={{ stage: "browser", plan }}
        onContinue={noop}
        onRetry={noop}
        onBack={noop}
        onDismissBrowser={onDismiss}
      />,
    );

    expect(
      screen.getByText("Finish your payment in the browser"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Processing...")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the credits rail on the blocking processing stage", () => {
    render(
      <DrivePlanFlowDialog
        flow={{ stage: "processing", plan }}
        onContinue={noop}
        onRetry={noop}
        onBack={noop}
        onDismissBrowser={noop}
      />,
    );

    expect(screen.getByText("Processing...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });
});

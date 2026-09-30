import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// The header's other cells read chain, plan and billing data; they have
// their own tests. Only the Capture opt-in is under test here.
vi.mock("@/app/lib/hooks/useStaking", () => ({ useStaking: () => ({ stakingInfo: { bondedHip: "0" } }) }));
vi.mock("@/components/ui/plan-chip", () => ({ default: () => null }));
vi.mock("@/components/ui/plan-chip/PlanActionButton", () => ({ default: () => null }));
vi.mock("@/components/ui/plan-chip/usePlanActionView", () => ({ usePlanActionView: () => null }));
vi.mock("@/components/capture/CaptureMenu", () => ({
  default: () => <button type="button">Capture</button>,
}));

import PageHeader from "../PageHeader";

describe("the shared home header's Capture button", () => {
  // Billing, Wallet, Referrals and Plans share this header; a Capture button
  // there has nothing to do with the page.
  it("is absent unless the page asks for it", () => {
    render(<PageHeader showPlanCard={false} />);
    expect(screen.queryByRole("button", { name: "Capture" })).toBeNull();
  });

  it("is offered when the page asks for it", () => {
    render(<PageHeader showPlanCard={false} showCapture />);
    expect(screen.getByRole("button", { name: "Capture" })).toBeInTheDocument();
  });
});

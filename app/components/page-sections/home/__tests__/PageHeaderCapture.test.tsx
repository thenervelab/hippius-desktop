import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// The header's other cells read chain, plan and billing data; they have
// their own tests. Only Capture's absence is under test here.
vi.mock("@/app/lib/hooks/useStaking", () => ({ useStaking: () => ({ stakingInfo: { bondedHip: "0" } }) }));
vi.mock("@/components/ui/plan-chip", () => ({ default: () => null }));
vi.mock("@/components/ui/plan-chip/PlanActionButton", () => ({ default: () => null }));
vi.mock("@/components/ui/plan-chip/usePlanActionView", () => ({ usePlanActionView: () => null }));
vi.mock("@/components/capture/CaptureMenu", () => ({
  default: () => <button type="button">Capture</button>,
}));

import PageHeader from "../PageHeader";

describe("the shared home header", () => {
  // Overview offers Capture in its Recent Files toolbar beside Folder and
  // File (recentFilesCapture.test.tsx); one up here too would show it twice,
  // and Billing, Wallet, Referrals and Plans share this header.
  it("never offers Capture itself", () => {
    render(<PageHeader showPlanCard={false} />);
    expect(screen.queryByRole("button", { name: "Capture" })).toBeNull();
  });
});

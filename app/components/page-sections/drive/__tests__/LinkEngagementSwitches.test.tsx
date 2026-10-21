import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import LinkEngagementSwitches, { INSIGHTS_LOCKED_DESCRIPTION } from "../LinkEngagementSwitches";
import { LOCKED_ACTION, LOCKED_PROMPT } from "@/components/page-sections/shares/insights/insightsView";

const ALL = { insights: true, comments: true, reactions: true };
const OFF = { insights: false, comments: false, reactions: false };

function setup(insightsInPlan: boolean | null, value = OFF) {
  const onChange = vi.fn();
  const onUpgrade = vi.fn();
  render(
    <LinkEngagementSwitches
      offered={ALL}
      value={value}
      insightsInPlan={insightsInPlan}
      onChange={onChange}
      onUpgrade={onUpgrade}
    />,
  );
  return { onChange, onUpgrade };
}

describe("LinkEngagementSwitches and the plan", () => {
  it("turns Insights on for a paid plan", () => {
    const { onChange } = setup(true);
    fireEvent.click(screen.getByRole("switch", { name: "Insights" }));
    expect(onChange).toHaveBeenCalledWith({ ...OFF, insights: true });
    expect(screen.queryByText(LOCKED_PROMPT)).toBeNull();
  });

  it("shows the upgrade prompt instead of turning Insights on for a free plan", () => {
    const { onChange, onUpgrade } = setup(false);
    expect(screen.getByText(INSIGHTS_LOCKED_DESCRIPTION)).toBeInTheDocument();
    expect(screen.queryByText(LOCKED_PROMPT)).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Insights" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Insights" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(LOCKED_PROMPT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: LOCKED_ACTION }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("leaves comments and reactions alone on a free plan", () => {
    const { onChange } = setup(false);
    fireEvent.click(screen.getByRole("switch", { name: "Comments" }));
    expect(onChange).toHaveBeenCalledWith({ ...OFF, comments: true });
    expect(screen.queryByText(LOCKED_PROMPT)).toBeNull();
  });

  it("lets a free link that already has Insights turn them off", () => {
    const { onChange } = setup(false, ALL);
    fireEvent.click(screen.getByRole("switch", { name: "Insights" }));
    expect(onChange).toHaveBeenCalledWith({ ...ALL, insights: false });
    expect(screen.queryByText(LOCKED_PROMPT)).toBeNull();
  });

  it("locks nothing when the plan could not be read", () => {
    const { onChange } = setup(null);
    expect(screen.queryByText(INSIGHTS_LOCKED_DESCRIPTION)).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Insights" }));
    expect(onChange).toHaveBeenCalledWith({ ...OFF, insights: true });
  });
});

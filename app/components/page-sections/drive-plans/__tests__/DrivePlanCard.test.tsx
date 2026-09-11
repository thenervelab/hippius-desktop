import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

import DrivePlanCard from "../DrivePlanCard";
import type { DrivePlan } from "@/lib/types/drive-plans";

/**
 * Shared drives are sold in the higher plans but are not switched on yet, so
 * the line is greyed and explains itself on hover. Pinned because both halves
 * fail silently: a plan gaining the perk row without the greying reads as
 * available on day one, and a trigger that stops being hoverable leaves a
 * dimmed line with no stated reason at all.
 */
const plan = (over: Partial<DrivePlan> = {}): DrivePlan =>
  ({
    code: "duo",
    name: "Plus",
    storage_bytes: 2 * 1024 ** 4,
    price_credits_monthly: 7,
    price_credits_annual: 7,
    is_free: false,
    ...over,
  }) as DrivePlan;

const renderCard = (p: DrivePlan) =>
  render(
    <DrivePlanCard
      plan={p}
      action="subscribe"
      isCurrent={false}
      isBusy={false}
      onAction={vi.fn()}
    />,
  );

describe("DrivePlanCard shared drive perk", () => {
  it("says coming soon when the greyed line is hovered", async () => {
    renderCard(plan());

    const row = screen.getByText("Shared team drive");
    expect(row).toBeTruthy();

    fireEvent.focus(row);
    fireEvent.pointerEnter(row);
    fireEvent.mouseEnter(row);

    expect(await screen.findAllByText("Coming soon")).not.toHaveLength(0);
  });

  it("states the reason without needing the tooltip at all", () => {
    renderCard(plan());
    // Screen readers must not depend on a hover-only surface.
    expect(screen.getByText(", coming soon")).toBeTruthy();
  });

  it("greys only the pending line, not the rest of the list", () => {
    renderCard(plan());

    const pending = screen.getByText("Shared team drive");
    const normal = screen.getByText("Automatic renewal");

    expect(pending.className).toContain("text-grey-70");
    expect(normal.className).not.toContain("text-grey-70");
  });

  it("shows no perk row on a plan that does not include it", () => {
    renderCard(plan({ code: "solo", name: "Starter" }));
    expect(screen.queryByText("Shared team drive")).toBeNull();
  });
});

/**
 * Two cards claiming to be the plan in use is the bug this replaces: the
 * free card returned "none" for every account, and "none" is labelled
 * "Current Plan" — so a subscriber saw it beside their paid plan's
 * "Cancel subscription".
 *
 * "Default Plan" is what it actually is: the plan underneath a
 * subscription, which cancelling returns you to. Inert, because the way
 * back is the paid card's own Cancel.
 */
describe("the free plan card beside a paid subscription", () => {
  const freePlan = plan({ code: "free", name: "Free Drive Plan", is_free: true });

  it("says Default Plan, not Current Plan", () => {
    render(
      <DrivePlanCard
        plan={freePlan}
        action="default"
        isCurrent={false}
        isBusy={false}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Default Plan")).toBeTruthy();
    expect(screen.queryByText("Current Plan")).toBeNull();
  });

  it("is not clickable", () => {
    const onAction = vi.fn();
    render(
      <DrivePlanCard
        plan={freePlan}
        action="default"
        isCurrent={false}
        isBusy={false}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByText("Default Plan"));
    expect(onAction).not.toHaveBeenCalled();
  });

  // An account genuinely on the free tier still reads "Current Plan".
  it("still says Current Plan for an account actually on it", () => {
    render(
      <DrivePlanCard
        plan={freePlan}
        action="none"
        isCurrent
        isBusy={false}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Current Plan")).toBeTruthy();
  });
});


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
 * The card states a plan's cost ONCE, in the price figure. A second line
 * under it restated the same number in credits ("A charge of 7 credits
 * monthly", "No monthly charge"), which said the same thing twice in a
 * different unit and pushed the one fact the card is chosen on — how much
 * storage — further down.
 */
describe("DrivePlanCard price", () => {
  it("states the cost once and does not restate it in credits", () => {
    renderCard(plan());
    expect(screen.getByText(/\$7/)).toBeTruthy();
    expect(screen.queryByText(/credits monthly/i)).toBeNull();
  });

  it("says nothing about a monthly charge on the free plan either", () => {
    renderCard(plan({ is_free: true, price_credits_monthly: 0, name: "Free Drive Plan" }));
    expect(screen.queryByText(/monthly charge/i)).toBeNull();
  });

  // The line that replaced it is the one the plan is actually chosen on.
  it("still names the storage the plan grants", () => {
    renderCard(plan());
    expect(screen.getByText(/storage on Hippius/i)).toBeTruthy();
  });
});


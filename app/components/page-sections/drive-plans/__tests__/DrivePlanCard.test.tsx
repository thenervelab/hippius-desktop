import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

import DrivePlanCard, { sharedDriveLine } from "../DrivePlanCard";
import type { DrivePlan } from "@/lib/types/drive-plans";

/**
 * Shared drives are live, so the plans that include them list the perk as
 * available, not greyed as coming soon. Plans without it list nothing.
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
  it("lists the perk as available, like the other lines", () => {
    renderCard(plan());

    const perk = screen.getByText("Shared team drive");
    const normal = screen.getByText("Automatic renewal");

    expect(perk.className).not.toContain("text-grey-70");
    expect(perk.className).toBe(normal.className);
  });

  it("no longer says coming soon", () => {
    renderCard(plan());
    expect(screen.queryByText(", coming soon")).toBeNull();
    expect(screen.queryByText("Coming soon")).toBeNull();
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

/**
 * Each plan that includes sharing says how many people one drive holds, from
 * the number Rust adds to the catalogue (Plus 3, Max 8, Scale 20).
 */
describe("DrivePlanCard people per drive", () => {
  it.each([
    ["duo", "Plus", 3],
    ["max", "Max", 8],
    ["scale", "Scale", 20],
  ] as const)("says how many people a %s drive holds", (code, name, people) => {
    renderCard(plan({ code, name, included_people: people }));
    expect(screen.getByText(`Shared drive for up to ${people} people`)).toBeTruthy();
    expect(screen.queryByText("Shared team drive")).toBeNull();
  });

  it("falls back to the plain perk when the number is missing", () => {
    renderCard(plan());
    expect(screen.getByText("Shared team drive")).toBeTruthy();
  });

  it("states no people on a plan without sharing, even if a number arrives", () => {
    renderCard(plan({ code: "solo", name: "Starter", included_people: 3 }));
    expect(screen.queryByText(/Shared drive for/)).toBeNull();
  });

  it("words one person and nonsense numbers", () => {
    expect(sharedDriveLine(1)).toBe("Shared drive for up to 1 person");
    expect(sharedDriveLine(0)).toBe("Shared team drive");
    expect(sharedDriveLine(undefined)).toBe("Shared team drive");
  });

  it("never mentions seats", () => {
    renderCard(plan({ included_people: 3 }));
    expect(screen.queryByText(/seat/i)).toBeNull();
  });
});

describe("DrivePlanCard Most popular badge", () => {
  it("marks Plus as the most popular", () => {
    renderCard(plan());
    expect(screen.getByText("Most popular")).toBeTruthy();
  });

  it.each(["free", "solo", "max", "scale"] as const)("does not mark %s", (code) => {
    renderCard(plan({ code, name: code }));
    expect(screen.queryByText("Most popular")).toBeNull();
  });
});

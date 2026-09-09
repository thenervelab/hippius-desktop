import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

import DrivePlanCard from "../DrivePlanCard";
import type { DrivePlan } from "@/lib/types/drive-plans";

/**
 * The "Shared team drive" perk line follows `SHARED_DRIVES_ENABLED`: while
 * the sharing surfaces are hidden the line is greyed and explains itself on
 * hover, and once they ship it is an ordinary line. Both states are pinned
 * because each failure is silent: a card selling the perk as usable while
 * the folder menus hide it (or the reverse) is exactly the contradiction the
 * flag gate exists to prevent, and a trigger that stops being hoverable
 * leaves a dimmed line with no stated reason at all.
 */
const flags = vi.hoisted(() => ({ SHARED_DRIVES_ENABLED: false }));
vi.mock("@/lib/featureFlags", () => flags);

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

describe("DrivePlanCard shared drive perk while shared drives are off", () => {
  beforeEach(() => {
    flags.SHARED_DRIVES_ENABLED = false;
  });

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
});

describe("DrivePlanCard shared drive perk once shared drives are on", () => {
  beforeEach(() => {
    flags.SHARED_DRIVES_ENABLED = true;
  });

  it("lists the perk as an ordinary line with no coming-soon note", () => {
    renderCard(plan());

    const line = screen.getByText("Shared team drive");
    expect(line.className).not.toContain("text-grey-70");
    expect(screen.queryByText(", coming soon")).toBeNull();
  });

  it("shows no perk row on a plan that does not include it", () => {
    renderCard(plan({ code: "solo", name: "Starter" }));
    expect(screen.queryByText("Shared team drive")).toBeNull();
  });
});

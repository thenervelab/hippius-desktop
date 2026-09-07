import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";

import PaymentMethodChoice from "../PaymentMethodChoice";

/**
 * The payment chooser, pinned on the three things about it that fail
 * silently.
 *
 * Card must lead. Paying from credits needs a balance a new subscriber
 * almost never has, so a chooser that lists credits first opens on the
 * option most people cannot use, and nothing about that is a type error or
 * a lint warning.
 *
 * The card row must say what the checkout accepts. "Pay by card" undersells
 * a Stripe checkout that also offers Link and Apple Pay, and a dropped
 * brand strip looks exactly like a deliberate design.
 *
 * The third-party disclaimer must stay gone. It was removed because the row
 * already names Stripe and says the checkout opens there; re-adding it as
 * row copy is the regression this exists to catch.
 */
const renderChoice = (over: Partial<{
  value: "credits" | "card";
  creditsBalance: number | null;
  creditsShort: boolean;
}> = {}) =>
  render(
    <PaymentMethodChoice
      value={over.value ?? "card"}
      creditsBalance={over.creditsBalance ?? 20}
      creditsShort={over.creditsShort ?? false}
      onChange={vi.fn()}
    />,
  );

/** The rails in the order the user reads them. */
const railLabels = () =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[name="drive-payment-rail"]',
    ),
  ).map((input) => input.id);

describe("PaymentMethodChoice", () => {
  it("lists card before credits", () => {
    renderChoice();
    expect(railLabels()).toEqual(["drive-rail-card", "drive-rail-credits"]);
  });

  it("names the card rail by what it does, not by the processor", () => {
    renderChoice();
    expect(screen.getByText("Pay by card")).toBeTruthy();
    expect(screen.getByText("Pay with credits")).toBeTruthy();
    // "Stripe" survives only as the chip beside the label.
    expect(screen.getByText("Stripe")).toBeTruthy();
  });

  it("shows the brand marks the Stripe checkout actually offers", () => {
    renderChoice();
    for (const brand of ["Visa", "Mastercard", "Link", "Apple Pay"]) {
      // One strip is rendered per breakpoint slot, so both are found; the
      // point is that the brand is named at all.
      expect(screen.getAllByLabelText(brand).length).toBeGreaterThan(0);
    }
  });

  it("puts the marks beside the Stripe chip, not across the row", () => {
    renderChoice();
    // The inline strip lives inside the card row's own label, alongside the
    // chip. Across the row it sat in the marker's container instead.
    const label = document.querySelector<HTMLElement>(
      'label[for="drive-rail-card"]',
    );
    expect(label).not.toBeNull();
    expect(within(label as HTMLElement).getByText("Stripe")).toBeTruthy();
    expect(within(label as HTMLElement).getAllByLabelText("Visa").length).toBe(
      1,
    );
  });

  it("does not carry the third-party disclaimer", () => {
    renderChoice();
    expect(screen.queryByText(/third-party website/i)).toBeNull();
    expect(screen.queryByText(/privacy practices/i)).toBeNull();
  });

  it("says the balance is short rather than hiding the credits rail", () => {
    renderChoice({ value: "card", creditsBalance: 0.19, creditsShort: true });

    expect(screen.getByText("Pay with credits")).toBeTruthy();
    expect(screen.getByText("0.19 available")).toBeTruthy();
    expect(
      screen.getByText(/Not enough credits for this plan/i),
    ).toBeTruthy();
    const credits = document.querySelector<HTMLInputElement>(
      "#drive-rail-credits",
    );
    expect(credits?.disabled).toBe(true);
  });

  it("asks whether the balance covers the plan, not what it is", () => {
    renderChoice({ creditsBalance: 20 });
    expect(screen.getByText("20.00 available")).toBeTruthy();
    expect(screen.queryByText("20.00 credits")).toBeNull();
  });
});

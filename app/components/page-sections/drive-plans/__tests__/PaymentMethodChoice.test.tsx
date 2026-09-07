import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

import PaymentMethodChoice from "../PaymentMethodChoice";

const openLinkByKey = vi.fn();
vi.mock("@/app/lib/utils/links", () => ({
  openLinkByKey: (...args: unknown[]) => openLinkByKey(...args),
}));

/**
 * The payment chooser, pinned on what fails silently.
 *
 * Card must lead. Paying from credits needs a balance a new subscriber
 * almost never has, so a chooser that puts credits first opens on the
 * option most people cannot use, and nothing about that is a type error.
 *
 * The card tile must say what the checkout accepts. "Card" undersells a
 * Stripe checkout that also offers Link and Apple Pay, and a dropped brand
 * strip looks exactly like a deliberate design.
 *
 * A short balance must stay selectable. Disabling that tile hid the two
 * things the user needed: how far short they are, and the Top up link. The
 * pay button is what waits instead, which is the dialog's job, so the rule
 * here is only that the tile can still be chosen and says the shortfall.
 *
 * And Top up must not pick the rail on its way out: it sits outside the
 * tile's labels precisely so a click on it does not also select credits.
 */
const renderChoice = (
  over: Partial<{
    value: "credits" | "card";
    creditsBalance: number | null;
    creditsShort: boolean;
    onChange: (rail: "credits" | "card") => void;
  }> = {},
) =>
  render(
    <PaymentMethodChoice
      value={over.value ?? "card"}
      creditsBalance={over.creditsBalance ?? 20}
      creditsShort={over.creditsShort ?? false}
      onChange={over.onChange ?? vi.fn()}
    />,
  );

/** The rails in the order the user reads them. */
const railOrder = () =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[name="drive-payment-rail"]',
    ),
  ).map((input) => input.id);

describe("PaymentMethodChoice", () => {
  it("puts card before credits", () => {
    renderChoice();
    expect(railOrder()).toEqual(["drive-rail-card", "drive-rail-credits"]);
  });

  it("shows the brand marks the Stripe checkout actually offers", () => {
    renderChoice();
    for (const brand of ["Visa", "Mastercard", "Link", "Apple Pay"]) {
      expect(screen.getByLabelText(brand)).toBeTruthy();
    }
  });

  it("explains the selected rail under the tiles, not inside them", () => {
    const { rerender } = renderChoice({ value: "card" });
    expect(screen.getByText(/Checkout opens on Stripe/i)).toBeTruthy();
    expect(screen.queryByText(/Hippius balance/i)).toBeNull();

    rerender(
      <PaymentMethodChoice
        value="credits"
        creditsBalance={20}
        creditsShort={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Charged from your Hippius balance/i)).toBeTruthy();
    expect(screen.queryByText(/Checkout opens on Stripe/i)).toBeNull();
  });

  it("keeps credits selectable when the balance is short", () => {
    const onChange = vi.fn();
    renderChoice({ creditsBalance: 0.19, creditsShort: true, onChange });

    const credits = document.querySelector<HTMLInputElement>(
      "#drive-rail-credits",
    );
    // Disabling it is the regression: it grey-outs the shortfall and the
    // Top up link, which are the only things the user can act on.
    expect(credits?.disabled).toBeFalsy();

    fireEvent.click(credits as HTMLInputElement);
    expect(onChange).toHaveBeenCalledWith("credits");
  });

  it("shows the shortfall and a Top up link only when short", () => {
    renderChoice({ creditsBalance: 0.19, creditsShort: true });
    expect(screen.getByText("0.19 available")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Top up" })).toBeTruthy();
  });

  it("offers no Top up link when the balance covers the plan", () => {
    renderChoice({ creditsBalance: 20, creditsShort: false });
    expect(screen.getByText("20.00 available")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Top up" })).toBeNull();
  });

  it("sends Top up to the console, from outside every label", () => {
    openLinkByKey.mockClear();
    renderChoice({ creditsBalance: 0.19, creditsShort: true });

    const topUp = screen.getByRole("button", { name: "Top up" });
    fireEvent.click(topUp);
    expect(openLinkByKey).toHaveBeenCalledWith("CREDITS");

    // Asserted structurally, not by firing a click and watching onChange: a
    // real browser forwards a click inside a `<label>` to that label's
    // control, and jsdom does not, so the click-based version passes just
    // as happily with the button nested in the label. Having no `<label>`
    // ancestor is the property that actually keeps Top up from picking the
    // credits rail on its way out.
    expect(topUp.closest("label")).toBeNull();
  });

  it("does not carry the third-party disclaimer", () => {
    renderChoice();
    expect(screen.queryByText(/third-party website/i)).toBeNull();
    expect(screen.queryByText(/privacy practices/i)).toBeNull();
  });
});

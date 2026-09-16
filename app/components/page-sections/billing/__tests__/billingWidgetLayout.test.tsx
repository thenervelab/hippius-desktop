// Pins the inner spacing of the Billing credits / deposit pair.
// Those two cards used to pack their rows with `p-3` and no gap, which
// read as cramped next to the rest of the page.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const creditsMocks = vi.hoisted(() => ({
  useUserCredits: vi.fn(),
}));
vi.mock("@/app/lib/hooks/api/useUserCredits", () => creditsMocks);

vi.mock("@/app/lib/utils/links", () => ({
  openLinkByKey: vi.fn(),
}));

const depositMocks = vi.hoisted(() => ({
  useDepositAddress: vi.fn(),
}));
vi.mock("@/app/lib/hooks/useDepositAddress", () => ({
  default: depositMocks.useDepositAddress,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import CreditsWidget from "../CreditsWidget";
import TaoDepositWidget from "../TaoDepositWidget";

beforeEach(() => {
  creditsMocks.useUserCredits.mockReturnValue({
    // planck is the source of truth the widget renders from, so it has to
    // agree with `hip` here or the mock describes an account that cannot exist.
    data: { planck: 14037794000000000000n, hip: "14.037794" },
    isLoading: false,
    refetch: vi.fn(),
    dataUpdatedAt: Date.now(),
  });
  depositMocks.useDepositAddress.mockReturnValue({
    data: "5GMuZjFpGkM83B4kL6eUUCAZLRVQA4p7RW9EXuBP5fxf3Xu7",
  });
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

describe("billing widget layout", () => {
  it("gives the credits card inner panel padding and a gap between the stat and the button", () => {
    render(<CreditsWidget />);

    // Quoted as money, rounded to the cent, not as a six-decimal token amount.
    expect(screen.getByText("$14.04")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /top up/i }),
    ).toBeInTheDocument();

    const panel = screen.getByRole("button", {
      name: /top up/i,
    }).parentElement;
    expect(panel?.className).toContain("gap-4");
    expect(panel?.className).toContain("px-4");
    expect(panel?.className).toContain("py-4");
    expect(panel?.className).not.toMatch(/(?:^|\s)p-3(?:\s|$)/);
  });

  it("gives the deposit card the same inner spacing as the credits card", () => {
    render(<TaoDepositWidget />);

    expect(screen.getByText("SS58 Bittensor Chain")).toBeInTheDocument();
    const copy = screen.getByRole("button", { name: "Copy wallet address" });
    const panel = copy.parentElement?.parentElement;
    expect(panel?.className).toContain("gap-4");
    expect(panel?.className).toContain("px-4");
    expect(panel?.className).toContain("py-4");
    expect(panel?.className).not.toMatch(/(?:^|\s)p-3(?:\s|$)/);
  });
});

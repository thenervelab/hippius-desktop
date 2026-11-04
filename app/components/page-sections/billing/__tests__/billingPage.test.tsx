import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { Provider, createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardPageHeaderAtom } from "@/components/dashboard-title-wrapper/dashboardAtoms";

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

// Radix owns hover/focus visibility; rendering its slots inline puts the
// tooltip's guide in the document so its words can be read, as the
// InfoTooltip's own test does.
vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children: ReactNode }) => children,
  Root: ({ children }: { children: ReactNode }) => children,
  Trigger: ({ children }: { children: ReactNode }) => children,
  Portal: ({ children }: { children: ReactNode }) => children,
  Content: ({ children }: { children: ReactNode }) => <div data-testid="tooltip">{children}</div>,
  Arrow: () => null,
}));

// The body reads plans, balances and history over IPC and has its own
// tests; only the page around it is under test here.
vi.mock("../BillingSections", () => ({
  default: () => <div data-testid="billing-sections" />,
}));
// The header's other cells read chain and plan data, with their own tests.
vi.mock("@/app/lib/hooks/useStaking", () => ({ useStaking: () => ({ stakingInfo: { bondedHip: "0" } }) }));
vi.mock("@/components/ui/plan-chip", () => ({ default: () => <div data-testid="plan-chip" /> }));
vi.mock("@/components/ui/plan-chip/PlanActionButton", () => ({ default: () => null }));
vi.mock("@/components/ui/plan-chip/usePlanActionView", () => ({ usePlanActionView: () => null }));

import Billing, { BILLING_DOCS_URL } from "..";

const SUBTITLE = "Your plan, your account balance, and everything you have been charged for.";

function renderPage() {
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <Billing />
    </Provider>,
  );
  return { store, ...view };
}

beforeEach(() => openUrlMock.mockReset());

/**
 * Plans & Billing is a page of its own under the main sidebar, as in the
 * console. Inside Settings the top bar read "Settings" over it.
 */
describe("the Plans & Billing page", () => {
  it("names itself in the top bar as the sidebar does, not Settings", () => {
    const { store } = renderPage();
    expect(store.get(dashboardPageHeaderAtom).mainText).toBe("Plans & Billing");
  });

  it("gives the top bar back when it is left", () => {
    const { store, unmount } = renderPage();
    unmount();
    expect(store.get(dashboardPageHeaderAtom).mainText).not.toBe("Plans & Billing");
  });

  it("carries the heading, the subtitle and the billing body", () => {
    renderPage();
    expect(screen.getByText("Plans & Billing")).toBeInTheDocument();
    expect(screen.getByText(SUBTITLE)).toBeInTheDocument();
    expect(screen.getByTestId("billing-sections")).toBeInTheDocument();
  });

  // The balance and next charge cards right below already state the plan
  // and the balance; the header's plan card would say it a third time.
  it("draws no plan card in its header", () => {
    renderPage();
    expect(screen.queryByTestId("plan-chip")).toBeNull();
  });
});

/**
 * The tooltip falls back to nothing here: it is a guide of its own. With no
 * tooltip of its own the hint behind the icon was the subtitle again.
 */
describe("the Plans & Billing tooltip is a guide, not the subtitle again", () => {
  const tooltip = () => screen.getByTestId("tooltip");

  it("explains both ways to pay: by card, or from the account balance", () => {
    renderPage();
    expect(tooltip()).toHaveTextContent("Two ways to pay for a storage plan");
    expect(tooltip()).toHaveTextContent(/By card:/);
    expect(tooltip()).toHaveTextContent(/From your account balance:/);
    expect(tooltip()).toHaveTextContent(/in dollars/);
  });

  // The balance is the account balance, in dollars, as on the console and
  // the balance card: "credits" asked the reader to learn an exchange rate.
  it("never speaks of credits, in the guide or the subtitle", () => {
    renderPage();
    expect(tooltip().textContent).not.toMatch(/credit/i);
    expect(SUBTITLE).not.toMatch(/credit/i);
    expect(screen.getByText(SUBTITLE)).toBeInTheDocument();
  });

  it("does not repeat the subtitle", () => {
    renderPage();
    expect(tooltip()).not.toHaveTextContent(SUBTITLE);
  });

  // Plain punctuation: the tooltip is a short guide, and em dashes read as
  // an aside inside instructions.
  it("uses no em dashes", () => {
    renderPage();
    expect(tooltip().textContent).not.toContain("—");
  });

  // Documentation opens in the user's browser through Tauri, never in the
  // app webview.
  it("links to the desktop billing docs, opened outside the app", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Learn More" }));
    expect(openUrlMock).toHaveBeenCalledWith(BILLING_DOCS_URL);
    expect(BILLING_DOCS_URL).toBe("https://docs.hippius.com/use/desktop/billing");
  });

  // The slug is owned by the docs site; if that repo is checked out beside
  // this one, keep the two in step.
  it("matches the slug the docs declare, when they are available", () => {
    const doc = resolve(process.cwd(), "../hippius-doc/docs/use/desktop/billing.md");
    if (!existsSync(doc)) return;
    expect(readFileSync(doc, "utf8")).toContain("slug: /use/desktop/billing");
  });
});

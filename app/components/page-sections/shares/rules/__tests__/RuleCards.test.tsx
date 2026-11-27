import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import { RuleCards, type LinkRule } from "../RuleCards";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { activeRecoveryCheckAtom, type RecoveryCheck } from "@/app/lib/global-atoms/recoveryAtoms";
import { LOCKED_LABEL } from "@/components/page-sections/shares/insights/DriveUnlock";

const unlockCalls = vi.hoisted(() => ({ n: 0 }));
const UNLOCK_CHECK: RecoveryCheck = {
  hasServerBlob: true,
  hasLocalMnemonic: false,
  canDecryptLocal: false,
  updatedAt: null,
  recommendedFlow: "unlock",
};
let store: ReturnType<typeof createStore>;
vi.mock("@/app/lib/hooks/useUnlockFlow", () => ({
  useUnlockFlow: () => ({
    unlock: async () => {
      unlockCalls.n += 1;
      store.set(activeRecoveryCheckAtom, UNLOCK_CHECK);
    },
    busy: false,
    isOAuth: true,
  }),
}));

const RULES: LinkRule[] = [
  { id: "gate", label: "Ask for email", on: true, value: "Code by email", editor: <p>gate editor</p> },
  { id: "watermark", label: "Watermark", on: false, value: "PDFs only" },
];

describe("rule cards", () => {
  it("shows each rule's label, On or Off and value in one column", () => {
    render(<RuleCards rules={RULES} />);
    const gate = screen.getByTestId("rule-gate");
    expect(gate).toHaveTextContent("Ask for email");
    expect(gate).toHaveTextContent("Code by email");
    expect(gate).toHaveTextContent("On");
    expect(screen.getByTestId("rule-watermark")).toHaveTextContent("Off");
  });

  it("a read-only rule is not a button", () => {
    render(<RuleCards rules={RULES} />);
    expect(within(screen.getByTestId("rule-watermark")).queryByRole("button")).toBeNull();
  });

  it("pushes a rule's editor in place of the cards, and Back returns focus to its card", async () => {
    const onPushedChange = vi.fn();
    render(<RuleCards rules={RULES} onPushedChange={onPushedChange} />);
    fireEvent.click(within(screen.getByTestId("rule-gate")).getByRole("button"));
    expect(screen.getByText("gate editor")).toBeInTheDocument();
    expect(screen.queryByTestId("rule-cards")).toBeNull();
    expect(screen.getByRole("heading", { name: "Ask for email" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toHaveFocus());
    expect(onPushedChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("gate editor")).toBeNull();
    await waitFor(() => expect(within(screen.getByTestId("rule-gate")).getByRole("button")).toHaveFocus());
    expect(onPushedChange).toHaveBeenLastCalledWith(false);
  });

  it("goes back to the cards when the open rule goes away", () => {
    const { rerender } = render(<RuleCards rules={RULES} />);
    fireEvent.click(within(screen.getByTestId("rule-gate")).getByRole("button"));
    rerender(<RuleCards rules={RULES.slice(1)} />);
    expect(screen.getByTestId("rule-cards")).toBeInTheDocument();
  });

  it("draws no On or Off for a rule that is not a switch, and keeps the whole value on hover", () => {
    render(<RuleCards rules={[{ id: "allowList", label: "Allow list", on: null, value: "acme.com, globex.com +3, 2 emails" }]} />);
    const card = screen.getByTestId("rule-allowList");
    expect(card).not.toHaveTextContent(/\b(On|Off)\b/);
    expect(within(card).getByText("acme.com, globex.com +3, 2 emails")).toHaveAttribute("title", "acme.com, globex.com +3, 2 emails");
  });

  it("a locked rule shows a lock, unlocks first, then opens; a cancelled unlock opens nothing", async () => {
    store = createStore();
    store.set(syncRequiresReauthAtom, true);
    unlockCalls.n = 0;
    render(
      <Provider store={store}>
        <RuleCards rules={[{ id: "allowList", label: "Allow list", on: null, value: "2 allowed", locked: true, editor: <p>lists editor</p> }]} />
      </Provider>,
    );
    const card = screen.getByTestId("rule-allowList");
    expect(within(card).getByText(LOCKED_LABEL)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button"));
    await waitFor(() => expect(unlockCalls.n).toBe(1));
    expect(screen.queryByText("lists editor")).toBeNull();
    await act(async () => store.set(activeRecoveryCheckAtom, null));
    expect(screen.queryByText("lists editor")).toBeNull();

    fireEvent.click(within(screen.getByTestId("rule-allowList")).getByRole("button"));
    await waitFor(() => expect(unlockCalls.n).toBe(2));
    await act(async () => {
      store.set(syncRequiresReauthAtom, false);
      store.set(activeRecoveryCheckAtom, null);
    });
    expect(await screen.findByText("lists editor")).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { Provider, createStore } from "jotai";

import EmailGateSettings, {
  ALLOW_ANYONE,
  GATE_LABEL,
  GATE_LOCKED_DESCRIPTION,
  GATE_LOCKED_PROMPT,
  LIST_PLACEHOLDER,
  gateCountsLine,
} from "../EmailGateSettings";
import { UNLOCK, UNLOCK_TO_SEE_LISTS } from "../DriveUnlock";
import { GATE_NOT_IN_PLAN, type LinkGate } from "@/app/lib/tauri/shareGate";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { activeRecoveryCheckAtom, type RecoveryCheck } from "@/app/lib/global-atoms/recoveryAtoms";

// The app's unlock asks Rust which flow applies and mounts the recovery
// dialog through `activeRecoveryCheckAtom`, which the dialog clears as it
// closes. This stands in for it: `unlock` opens the "dialog".
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

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const OFF: LinkGate = { offered: true, on: false, allowCount: 0, blockCount: 0, lists: null, inPlan: true };
const ON_EMPTY: LinkGate = { ...OFF, on: true, lists: { allow: [], block: [] } };

/** Answers each gate command from `replies`, recording what was sent. */
/** Rust's split and check of a list box (`gate_entries`): "nope" is not an entry. */
function chips(text: string) {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))].map((value) => ({
    value,
    error: value.includes(".") ? null : `"${value}" isn't an email address or a domain.`,
  }));
}

function answer(replies: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    const reply = cmd === "share_parse_gate_entries" ? (a: Record<string, unknown>) => chips(String(a.text)) : replies[cmd];
    if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
    try {
      return Promise.resolve(reply(args));
    } catch (err) {
      return Promise.reject(err);
    }
  });
}

function renderIt({ locked = false, part }: { locked?: boolean; part?: "switch" | "lists" } = {}) {
  const onUpgrade = vi.fn();
  store = createStore();
  store.set(syncRequiresReauthAtom, locked);
  render(
    <Provider store={store}>
      <EmailGateSettings shareToken="tok" onUpgrade={onUpgrade} part={part} />
    </Provider>,
  );
  return { onUpgrade };
}

/** The recovery dialog closes, after an unlock or a cancel. */
async function closeUnlock({ unlocked }: { unlocked: boolean }) {
  await act(async () => {
    if (unlocked) store.set(syncRequiresReauthAtom, false);
    store.set(activeRecoveryCheckAtom, null);
  });
}

describe("EmailGateSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(toast.error).mockClear();
    unlockCalls.n = 0;
  });

  it("draws nothing on a server without email gates, or while the read fails", async () => {
    answer({ share_get_gate: () => ({ ...OFF, offered: false }) });
    const { unmount } = render(<EmailGateSettings shareToken="tok" onUpgrade={vi.fn()} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_get_gate", { shareToken: "tok" }));
    expect(screen.queryByRole("switch", { name: GATE_LABEL })).toBeNull();
    unmount();

    answer({});
    render(<EmailGateSettings shareToken="tok" onUpgrade={vi.fn()} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByRole("switch", { name: GATE_LABEL })).toBeNull();
  });

  it("turns the gate on for anyone with an email, then saves the lists as typed", async () => {
    answer({
      share_get_gate: () => OFF,
      share_set_gate: (a) =>
        a.allow === "" && a.block === ""
          ? ON_EMPTY
          : { ...ON_EMPTY, allowCount: 1, blockCount: 0, lists: { allow: ["acme.com"], block: [] } },
    });
    renderIt();
    const gate = await screen.findByRole("switch", { name: GATE_LABEL });
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(gate);
    await waitFor(() => expect(gate).toHaveAttribute("aria-checked", "true"));
    expect(invokeMock).toHaveBeenCalledWith("share_set_gate", { shareToken: "tok", allow: "", block: "" });
    const allow = screen.getByRole("textbox", { name: "Only allow" });
    expect(screen.getByRole("textbox", { name: "Block" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    // Typing, then a comma, makes a chip of what Rust would store.
    fireEvent.change(allow, { target: { value: "ACME.com," } });
    expect(await screen.findByText("acme.com")).toBeInTheDocument();
    expect(allow).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_set_gate", { shareToken: "tok", allow: "acme.com", block: "" }));
    // What Rust stored is shown back, and there is nothing left to save.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
    expect(screen.getAllByTestId("gate-chip").map((c) => c.textContent)).toEqual(["acme.com"]);
  });

  it("names an entry Rust would not take, in place", async () => {
    const refusal = { kind: "Validation", message: "\"nope\" isn't an email address or a domain." };
    answer({
      share_get_gate: () => ON_EMPTY,
      share_set_gate: () => {
        throw refusal;
      },
    });
    renderIt();
    // The server refuses an entry Rust's first check let through.
    const block = await screen.findByRole("textbox", { name: "Block" });
    fireEvent.change(block, { target: { value: "nope.example" } });
    fireEvent.keyDown(block, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal.message);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("on the free plan, shows the upgrade card instead of turning it on", async () => {
    answer({ share_get_gate: () => ({ ...OFF, inPlan: false }) });
    const { onUpgrade } = renderIt();
    const gate = await screen.findByRole("switch", { name: GATE_LABEL });
    expect(screen.getByText(GATE_LOCKED_DESCRIPTION)).toBeInTheDocument();
    fireEvent.click(gate);
    expect(gate).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(GATE_LOCKED_PROMPT)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("share_set_gate", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(onUpgrade).toHaveBeenCalled();
  });

  it("shows the upgrade card when the server refuses it for the plan", async () => {
    answer({
      share_get_gate: () => ({ ...OFF, inPlan: null }),
      share_set_gate: () => {
        throw { kind: "Validation", message: GATE_NOT_IN_PLAN };
      },
    });
    renderIt();
    fireEvent.click(await screen.findByRole("switch", { name: GATE_LABEL }));
    expect(await screen.findByText(GATE_LOCKED_PROMPT)).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("turns it off on any plan", async () => {
    answer({ share_get_gate: () => ({ ...ON_EMPTY, inPlan: false }), share_remove_gate: () => undefined });
    renderIt();
    const gate = await screen.findByRole("switch", { name: GATE_LABEL });
    expect(gate).toHaveAttribute("aria-checked", "true");
    fireEvent.click(gate);
    await waitFor(() => expect(gate).toHaveAttribute("aria-checked", "false"));
    expect(invokeMock).toHaveBeenCalledWith("share_remove_gate", { shareToken: "tok" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows only the counts when the lists can't be opened on this computer", async () => {
    answer({ share_get_gate: () => ({ ...OFF, on: true, allowCount: 3, blockCount: 1, lists: null }) });
    renderIt();
    expect(await screen.findByText("3 allowed, 1 blocked.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(gateCountsLine({ allowCount: 0, blockCount: 0 })).toBe("Anyone with an email can open it.");
  });

  it("says both lists take several emails and whole domains, and an empty Only allow reads Anyone", async () => {
    answer({ share_get_gate: () => ON_EMPTY });
    renderIt();
    const allow = await screen.findByRole("textbox", { name: "Only allow" });
    expect(allow).toHaveAttribute("placeholder", LIST_PLACEHOLDER);
    expect(screen.getByRole("textbox", { name: "Block" })).toHaveAttribute("placeholder", LIST_PLACEHOLDER);
    expect(screen.getByText(ALLOW_ANYONE)).toBeInTheDocument();
  });

  it("makes a chip per entry from a pasted list, and Backspace or Remove takes one back", async () => {
    answer({ share_get_gate: () => ON_EMPTY });
    renderIt();
    const allow = await screen.findByRole("textbox", { name: "Only allow" });
    fireEvent.paste(allow, { clipboardData: { getData: () => "Dana@Acme.com\nglobex.com; bob@x.io" } });
    await waitFor(() =>
      expect(screen.getAllByTestId("gate-chip").map((c) => c.textContent)).toEqual(["dana@acme.com", "globex.com", "bob@x.io"]),
    );
    expect(screen.queryByText(ALLOW_ANYONE)).toBeNull();
    fireEvent.keyDown(allow, { key: "Backspace" });
    expect(screen.getAllByTestId("gate-chip")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove dana@acme.com" }));
    expect(screen.getAllByTestId("gate-chip").map((c) => c.textContent)).toEqual(["globex.com"]);
  });

  it("shows an entry Rust would refuse as an error chip in Rust's words, and saves nothing", async () => {
    answer({ share_get_gate: () => ON_EMPTY, share_set_gate: () => ON_EMPTY });
    renderIt();
    const allow = await screen.findByRole("textbox", { name: "Only allow" });
    fireEvent.change(allow, { target: { value: "acme.com nope" } });
    fireEvent.keyDown(allow, { key: "Enter" });
    const bad = await waitFor(() => {
      const chip = screen.getAllByTestId("gate-chip").find((c) => c.getAttribute("data-invalid") === "true");
      expect(chip).toBeDefined();
      return chip!;
    });
    expect(bad).toHaveTextContent("nope");
    expect(screen.getByRole("alert")).toHaveTextContent(`"nope" isn't an email address or a domain.`);
    expect(allow).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(within(bad).getByRole("button", { name: "Remove nope" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(invokeMock).not.toHaveBeenCalledWith("share_set_gate", expect.anything());
  });

  it("never turns Ask for email off when the lists change, or fail to", async () => {
    let fail = true;
    answer({
      share_get_gate: () => ON_EMPTY,
      share_set_gate: () => {
        if (fail) throw { kind: "Network", message: "unreachable" };
        return { ...ON_EMPTY, allowCount: 1, lists: { allow: ["acme.com"], block: [] } };
      },
      share_remove_gate: () => undefined,
    });
    renderIt();
    const gate = await screen.findByRole("switch", { name: GATE_LABEL });
    const allow = screen.getByRole("textbox", { name: "Only allow" });
    fireEvent.change(allow, { target: { value: "acme.com," } });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(gate).toHaveAttribute("aria-checked", "true");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
    expect(gate).toHaveAttribute("aria-checked", "true");
    // Emptying the lists again is "anyone with an email", still asking.
    fireEvent.click(screen.getByRole("button", { name: "Remove acme.com" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith("share_set_gate", { shareToken: "tok", allow: "", block: "" }));
    expect(invokeMock).not.toHaveBeenCalledWith("share_remove_gate", expect.anything());
  });

  it("while the Drive is locked, the lists say so with Unlock, and show again once it is unlocked", async () => {
    let unlocked = false;
    answer({
      share_get_gate: () =>
        unlocked ? { ...ON_EMPTY, allowCount: 1, lists: { allow: ["acme.com"], block: [] } } : { ...ON_EMPTY, allowCount: 1, lists: null },
    });
    renderIt({ locked: true, part: "lists" });
    expect(await screen.findByText(UNLOCK_TO_SEE_LISTS)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: UNLOCK }));
    await waitFor(() => expect(unlockCalls.n).toBe(1));
    unlocked = true;
    await closeUnlock({ unlocked: true });
    // Read again after the unlock: the lists open and can be changed.
    expect(await screen.findByRole("textbox", { name: "Only allow" })).toBeInTheDocument();
    expect(screen.getAllByTestId("gate-chip").map((c) => c.textContent)).toEqual(["acme.com"]);
    expect(screen.queryByText(UNLOCK_TO_SEE_LISTS)).toBeNull();
  });

  it("while the Drive is locked, turning it on unlocks first and then turns it on; a cancel changes nothing", async () => {
    answer({ share_get_gate: () => OFF, share_set_gate: () => ON_EMPTY });
    renderIt({ locked: true });
    const gate = await screen.findByRole("switch", { name: GATE_LABEL });
    fireEvent.click(gate);
    await waitFor(() => expect(unlockCalls.n).toBe(1));
    await closeUnlock({ unlocked: false });
    expect(invokeMock).not.toHaveBeenCalledWith("share_set_gate", expect.anything());
    expect(gate).toHaveAttribute("aria-checked", "false");

    fireEvent.click(gate);
    await waitFor(() => expect(unlockCalls.n).toBe(2));
    await closeUnlock({ unlocked: true });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_set_gate", { shareToken: "tok", allow: "", block: "" }));
  });
});

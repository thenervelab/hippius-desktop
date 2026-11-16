import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { toast } from "sonner";

import EmailGateSettings, { GATE_LABEL, GATE_LOCKED_DESCRIPTION, GATE_LOCKED_PROMPT, gateCountsLine } from "../EmailGateSettings";
import { GATE_NOT_IN_PLAN, type LinkGate } from "@/app/lib/tauri/shareGate";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const OFF: LinkGate = { offered: true, on: false, allowCount: 0, blockCount: 0, lists: null, inPlan: true };
const ON_EMPTY: LinkGate = { ...OFF, on: true, lists: { allow: [], block: [] } };

/** Answers each gate command from `replies`, recording what was sent. */
function answer(replies: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    const reply = replies[cmd];
    if (!reply) return Promise.reject(new Error(`unexpected ${cmd}`));
    try {
      return Promise.resolve(reply(args));
    } catch (err) {
      return Promise.reject(err);
    }
  });
}

function renderIt() {
  const onUpgrade = vi.fn();
  render(<EmailGateSettings shareToken="tok" onUpgrade={onUpgrade} />);
  return { onUpgrade };
}

describe("EmailGateSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(toast.error).mockClear();
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

    fireEvent.change(allow, { target: { value: "ACME.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_set_gate", { shareToken: "tok", allow: "ACME.com", block: "" }));
    // What Rust stored is shown back, and there is nothing left to save.
    await waitFor(() => expect(allow).toHaveValue("acme.com"));
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
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
    fireEvent.change(await screen.findByRole("textbox", { name: "Block" }), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
});

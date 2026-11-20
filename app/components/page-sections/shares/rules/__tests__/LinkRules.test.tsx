import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { LinkRules } from "../LinkRules";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const GATE_OFF = { offered: true, on: false, allowCount: 0, blockCount: 0, lists: null, inPlan: true };
const NO_NDA = { offered: false, on: false, text: null, editable: false, inPlan: true };

function answer(gate: unknown, nda: unknown = NO_NDA) {
  invokeMock.mockImplementation((cmd: string, args?: { allow?: string; block?: string }) => {
    if (cmd === "share_get_gate") return Promise.resolve(gate);
    if (cmd === "share_get_nda") return Promise.resolve(nda);
    if (cmd === "share_set_gate")
      return Promise.resolve({ ...GATE_OFF, on: true, allowCount: 1, lists: { allow: [args?.allow ?? ""], block: [] } });
    return Promise.resolve(undefined);
  });
}

function renderRules(more: Partial<Parameters<typeof LinkRules>[0]> = {}) {
  return render(
    <LinkRules shareToken="tok" fileName="deck.pdf" expiresAt={null} passwordOn={false} onUpgrade={() => undefined} {...more} />,
  );
}

describe("a link's rule cards", () => {
  beforeEach(() => invokeMock.mockReset());

  it("shows only the rules this link has, in the console's order", async () => {
    answer(GATE_OFF);
    renderRules({ download: false, onDownloadChange: () => undefined });
    await screen.findByTestId("rule-gate");
    const ids = within(screen.getByTestId("rule-cards"))
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("data-testid"));
    expect(ids).toEqual(["rule-gate", "rule-allowList", "rule-watermark", "rule-download", "rule-expiry", "rule-password"]);
    // Today's watermark: a PDF with downloads off. It only reads.
    expect(screen.getByTestId("rule-watermark")).toHaveTextContent("On");
    expect(within(screen.getByTestId("rule-watermark")).queryByRole("button")).toBeNull();
    expect(screen.getByTestId("rule-password")).toHaveTextContent("Set when the link was made");
  });

  it("hides Ask for email and Allow list where the server has no email gates", async () => {
    answer({ ...GATE_OFF, offered: false });
    renderRules();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_get_gate", { shareToken: "tok" }));
    expect(screen.queryByTestId("rule-gate")).toBeNull();
    expect(screen.queryByTestId("rule-allowList")).toBeNull();
  });

  it("asks a folder link for no gate or NDA", () => {
    answer(GATE_OFF);
    renderRules({ shareToken: null });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("rule-watermark")).toBeNull();
    expect(screen.getByTestId("rule-expiry")).toBeInTheDocument();
  });

  it("saving an allow list turns the gate on, and both cards follow", async () => {
    answer(GATE_OFF);
    renderRules();
    fireEvent.click(within(await screen.findByTestId("rule-allowList")).getByRole("button"));
    fireEvent.change(screen.getByRole("textbox", { name: "Only allow" }), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_gate", { shareToken: "tok", allow: "acme.com", block: "" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("rule-allowList")).toHaveTextContent("acme.com");
    expect(screen.getByTestId("rule-gate")).toHaveTextContent("On");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { toast } from "sonner";

import NdaSettings, { NDA_LABEL, NDA_LOCKED_DESCRIPTION, NDA_LOCKED_PROMPT, NDA_NOT_HERE } from "../NdaSettings";
import { NDA_NOT_IN_PLAN, type LinkNda } from "@/app/lib/tauri/shareNda";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const OFF: LinkNda = { offered: true, on: false, text: null, editable: true, inPlan: true };
const ON: LinkNda = { ...OFF, on: true, text: "Keep it to yourself." };

/** Answers each NDA command from `replies`, recording what was sent. */
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
  render(<NdaSettings shareToken="tok" onUpgrade={onUpgrade} layout="list" />);
  return { onUpgrade };
}

describe("NdaSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it("draws nothing where Rust doesn't offer it (no server support, a password link) or while the read fails", async () => {
    answer({ share_get_nda: () => ({ ...OFF, offered: false, editable: false }) });
    const { unmount } = render(<NdaSettings shareToken="tok" onUpgrade={vi.fn()} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_get_nda", { shareToken: "tok" }));
    expect(screen.queryByRole("switch", { name: NDA_LABEL })).toBeNull();
    unmount();

    answer({});
    render(<NdaSettings shareToken="tok" onUpgrade={vi.fn()} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByTestId("nda-settings")).toBeNull();
  });

  it("opens a text box on, sends nothing until Save, then saves the text as typed", async () => {
    answer({ share_get_nda: () => OFF, share_set_nda: (a) => ({ ...ON, text: String(a.text).trim() }) });
    renderIt();
    const toggle = await screen.findByRole("switch", { name: NDA_LABEL });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(toggle);
    const box = await screen.findByRole("textbox", { name: "NDA text" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(invokeMock).not.toHaveBeenCalledWith("share_set_nda", expect.anything());
    // Nothing to save while the box is empty.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.change(box, { target: { value: "  Don't share this.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_nda", { shareToken: "tok", text: "  Don't share this.\n" }),
    );
    await waitFor(() => expect(box).toHaveValue("Don't share this."));
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Saved");
  });

  it("shows the stored text and removes it when turned off", async () => {
    answer({ share_get_nda: () => ON, share_remove_nda: () => undefined });
    renderIt();
    // The box can mount a render before the stored text fills it.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "NDA text" })).toHaveValue("Keep it to yourself."));

    fireEvent.click(screen.getByRole("switch", { name: NDA_LABEL }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_remove_nda", { shareToken: "tok" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: NDA_LABEL })).toHaveAttribute("aria-checked", "false"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("turning it on and back off before saving sends nothing", async () => {
    answer({ share_get_nda: () => OFF });
    renderIt();
    const toggle = await screen.findByRole("switch", { name: NDA_LABEL });
    fireEvent.click(toggle);
    await screen.findByRole("textbox", { name: "NDA text" });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual(["share_get_nda"]);
  });

  it("shows the upgrade card on the free plan instead of opening the box", async () => {
    answer({ share_get_nda: () => ({ ...OFF, inPlan: false }) });
    const { onUpgrade } = renderIt();
    expect(await screen.findByText(NDA_LOCKED_DESCRIPTION)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: NDA_LABEL }));
    expect(await screen.findByText(NDA_LOCKED_PROMPT)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(onUpgrade).toHaveBeenCalled();
  });

  it("lets an account without the plan remove a text it already has", async () => {
    answer({ share_get_nda: () => ({ ...ON, inPlan: false }), share_remove_nda: () => undefined });
    renderIt();
    const toggle = await screen.findByRole("switch", { name: NDA_LABEL });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_remove_nda", { shareToken: "tok" }));
    expect(screen.queryByText(NDA_LOCKED_PROMPT)).toBeNull();
  });

  it("turns Rust's plan refusal on Save into the upgrade card, and its other refusals into a line", async () => {
    let refusal: unknown = { kind: "Validation", message: NDA_NOT_IN_PLAN };
    answer({
      share_get_nda: () => ON,
      share_set_nda: () => {
        throw refusal;
      },
    });
    renderIt();
    const box = await screen.findByRole("textbox", { name: "NDA text" });
    fireEvent.change(box, { target: { value: "New terms." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(NDA_LOCKED_PROMPT)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();

    refusal = { kind: "Validation", message: "The text is too long." };
    // Found again, not reused: the editor re-renders after the refusal, and on
    // a slow runner the button is not back yet when the prompt appears.
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The text is too long.");
  });

  it("says a text set elsewhere can't be opened here, and still lets it be turned off", async () => {
    answer({ share_get_nda: () => ({ ...ON, text: null, editable: false }), share_remove_nda: () => undefined });
    renderIt();
    expect(await screen.findByTestId("nda-not-here")).toHaveTextContent(NDA_NOT_HERE);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: NDA_LABEL }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_remove_nda", { shareToken: "tok" }));
  });
});

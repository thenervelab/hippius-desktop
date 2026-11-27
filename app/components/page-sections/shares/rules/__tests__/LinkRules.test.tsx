import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { Provider, createStore } from "jotai";

import { LinkRules } from "../LinkRules";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";
import { WATERMARK_UPGRADE_LABEL } from "@/components/page-sections/drive/LinkEngagementSwitches";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const GATE_OFF = { offered: true, on: false, allowCount: 0, blockCount: 0, lists: null, inPlan: true };
const NO_NDA = { offered: false, on: false, text: null, editable: false, inPlan: true };

function answer(gate: unknown, nda: unknown = NO_NDA) {
  invokeMock.mockImplementation((cmd: string, args?: { allow?: string; block?: string }) => {
    if (cmd === "share_get_gate") return Promise.resolve(gate);
    if (cmd === "share_get_nda") return Promise.resolve(nda);
    if (cmd === "share_expiry_day_range") return Promise.resolve({ min: "2026-11-24", max: "2027-11-22" });
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

  it("says why a password link has no NDA instead of leaving the card out", async () => {
    answer({ ...GATE_OFF, offered: false }, { ...NO_NDA, passwordLink: true });
    renderRules({ passwordOn: true });
    const card = await screen.findByTestId("rule-nda");
    expect(card).toHaveTextContent("Not on password links");
    expect(card).toHaveTextContent("Off");
    fireEvent.click(within(card).getByRole("button"));
    expect(screen.getByTestId("nda-password-reason")).toHaveTextContent(
      "The NDA is encrypted with the link's key, which needs the link's password.",
    );
    expect(screen.queryByRole("switch")).toBeNull();
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

  it("turns the watermark on and off with its own switch, on a PDF where the server has one", async () => {
    answer(GATE_OFF);
    const onWatermarkChange = vi.fn();
    renderRules({ download: true, onDownloadChange: () => undefined, watermark: false, onWatermarkChange, switchesInPlan: true });
    const card = await screen.findByTestId("rule-watermark");
    expect(card).toHaveTextContent("Off");
    fireEvent.click(within(card).getByRole("button"));
    fireEvent.click(screen.getByRole("switch", { name: "Watermark" }));
    expect(onWatermarkChange).toHaveBeenCalledWith(true);
  });

  it("shows the upgrade card instead of turning the watermark on from the free plan", async () => {
    answer(GATE_OFF);
    const onWatermarkChange = vi.fn();
    renderRules({ watermark: false, onWatermarkChange, switchesInPlan: false });
    fireEvent.click(within(await screen.findByTestId("rule-watermark")).getByRole("button"));
    fireEvent.click(screen.getByRole("switch", { name: "Watermark" }));
    expect(onWatermarkChange).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: WATERMARK_UPGRADE_LABEL })).toBeInTheDocument();
  });

  it("keeps the watermark read only off a PDF, even where it is a switch", async () => {
    answer(GATE_OFF);
    renderRules({ fileName: "clip.mp4", watermark: true, onWatermarkChange: () => undefined });
    const card = await screen.findByTestId("rule-watermark");
    expect(card).toHaveTextContent("PDFs only");
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("ends a link on a chosen day where the server takes one, keeping the presets", async () => {
    answer(GATE_OFF);
    const store = createStore();
    store.set(serverCapabilitiesAtom, { shares: true, share_expiry_date: true } as ServerCapabilities);
    const onDate = vi.fn();
    const onChange = vi.fn();
    render(
      <Provider store={store}>
        <LinkRules
          shareToken="tok"
          fileName="deck.pdf"
          expiresAt="2026-12-01T00:00:00Z"
          expiry={{ ttl: "7d", saving: false, onChange, onDate }}
          onUpgrade={() => undefined}
        />
      </Provider>,
    );
    fireEvent.click(within(screen.getByTestId("rule-expiry")).getByRole("button"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_expiry_day_range"));
    fireEvent.keyDown(screen.getByLabelText("Link expires"), { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("option", { name: "On a date" }), { key: "Enter" });
    const field = await screen.findByLabelText("Ends on");
    expect(field).toHaveAttribute("min", "2026-11-24");
    expect(field).toHaveAttribute("max", "2027-11-22");
    // A day outside the range cannot be saved.
    fireEvent.change(field, { target: { value: "2028-01-01" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "2026-12-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onDate).toHaveBeenCalledWith("2026-12-20");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers only the presets where the server takes no chosen date", async () => {
    answer(GATE_OFF);
    renderRules({ expiry: { ttl: "7d", saving: false, onChange: () => undefined, onDate: () => undefined } });
    fireEvent.click(within(screen.getByTestId("rule-expiry")).getByRole("button"));
    fireEvent.keyDown(screen.getByLabelText("Link expires"), { key: "Enter" });
    await screen.findByRole("option", { name: "30 days" });
    expect(screen.queryByRole("option", { name: "On a date" })).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("share_expiry_day_range");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { toast } from "sonner";

import RecipientLinks, { allLinksText, COPY_ALL, mergePeople, UNNAMED_LINK } from "../RecipientLinks";
import type { RecipientLinks as View, RecipientPerson } from "@/app/lib/tauri/shareRecipients";

const invokeMock = vi.fn();
const openUrlMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...args: unknown[]) => openUrlMock(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ALICE: RecipientPerson = { shareToken: "a", name: "Alice", url: "https://c/share/a#s=AA", mailto: null };
const BOB: RecipientPerson = {
  shareToken: "b",
  name: "bob@example.com",
  url: "https://c/share/b#s=BB",
  mailto: "mailto:bob@example.com?subject=f&body=x",
};

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

const view = (v: Partial<View>): View => ({ offered: true, canAdd: true, people: [], ...v });

describe("RecipientLinks", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openUrlMock.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("draws nothing where Rust doesn't offer it, or while the read fails", async () => {
    answer({ share_recipient_links: () => view({ offered: false }) });
    const { unmount } = render(<RecipientLinks shareToken="tok" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_recipient_links", { shareToken: "tok" }));
    expect(screen.queryByTestId("recipient-links")).toBeNull();
    unmount();

    answer({});
    render(<RecipientLinks shareToken="tok" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByTestId("recipient-links")).toBeNull();
  });

  it("sends the names as typed, lists the new links and puts back what was not made", async () => {
    answer({
      share_recipient_links: () => view({}),
      share_add_recipient_links: () => ({ people: [ALICE], left: "Carol", error: "A file can have up to 100 links." }),
    });
    render(<RecipientLinks shareToken="tok" />);
    const box = await screen.findByRole("textbox", { name: "Names or emails" });
    fireEvent.change(box, { target: { value: "Alice, Carol" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_add_recipient_links", { shareToken: "tok", names: "Alice, Carol" }),
    );
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(box).toHaveValue("Carol");
    expect(screen.getByRole("alert")).toHaveTextContent("A file can have up to 100 links.");
  });

  it("copies one link, opens an email in the mail app, and copies them all", async () => {
    answer({ share_recipient_links: () => view({ people: [ALICE, BOB] }) });
    render(<RecipientLinks shareToken="tok" />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy link for Alice" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ALICE.url));

    expect(screen.queryByRole("button", { name: "Email link to Alice" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Email link to bob@example.com" }));
    expect(openUrlMock).toHaveBeenCalledWith(BOB.mailto);

    fireEvent.click(screen.getByRole("button", { name: COPY_ALL }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(`Alice: ${ALICE.url}\nbob@example.com: ${BOB.url}`),
    );
  });

  it("asks in the row before revoking one link, and keeps the others", async () => {
    answer({ share_recipient_links: () => view({ canAdd: false, people: [ALICE, BOB] }), share_revoke_recipient_link: () => undefined });
    render(<RecipientLinks shareToken="tok" />);
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Revoke link for Alice" }));
    expect(invokeMock).not.toHaveBeenCalledWith("share_revoke_recipient_link", expect.anything());
    const row = screen.getByText("Revoke link for Alice?").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_revoke_recipient_link", { shareToken: "a" }));
    await waitFor(() => expect(screen.queryByText("Alice")).toBeNull());
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("names a link that can't be opened here, and offers no copy without its link", async () => {
    answer({ share_recipient_links: () => view({ people: [{ shareToken: "x", name: null, url: null, mailto: null }] }) });
    render(<RecipientLinks shareToken="tok" />);
    expect(await screen.findByText(UNNAMED_LINK)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy link/ })).toBeNull();
  });
});

describe("recipient link helpers", () => {
  it("copies only the links known here, one per line", () => {
    expect(allLinksText([ALICE, { ...BOB, url: null }, { ...ALICE, shareToken: "c", name: null }])).toBe(
      `Alice: ${ALICE.url}\n${UNNAMED_LINK}: ${ALICE.url}`,
    );
  });

  it("keeps a just-made link's URL when the listing has not caught up", () => {
    const listed = [{ ...ALICE, url: null }];
    expect(mergePeople(listed, [ALICE, BOB])).toEqual([ALICE, BOB]);
  });
});

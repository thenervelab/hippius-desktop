import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { toast } from "sonner";
import { Provider, createStore } from "jotai";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { activeRecoveryCheckAtom, type RecoveryCheck } from "@/app/lib/global-atoms/recoveryAtoms";

import RecipientLinks, {
  allLinksText,
  COPY_ALL,
  mergePeople,
  NDA_PENDING_NOTE,
  RECIPIENTS_LOCKED_PROMPT,
  RECIPIENTS_UPGRADE_LABEL,
  UNNAMED_LINK,
} from "../RecipientLinks";
import type { RecipientLinks as View, RecipientPerson } from "@/app/lib/tauri/shareRecipients";

const invokeMock = vi.fn();
const openUrlMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...args: unknown[]) => openUrlMock(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

const ALICE: RecipientPerson = { shareToken: "a", name: "Alice", url: "https://c/share/a#s=AA", mailto: null, ndaPending: false };
const BOB: RecipientPerson = {
  shareToken: "b",
  name: "bob@example.com",
  url: "https://c/share/b#s=BB",
  mailto: "mailto:bob@example.com?subject=f&body=x",
  ndaPending: false,
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

const view = (v: Partial<View>): View => ({ offered: true, canAdd: true, people: [], inPlan: true, ...v });

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

  it("shows the upgrade card in place of the box on the free plan, and keeps the links already made", async () => {
    answer({ share_recipient_links: () => view({ inPlan: false, people: [ALICE] }) });
    const onUpgrade = vi.fn();
    render(<RecipientLinks shareToken="tok" onUpgrade={onUpgrade} />);
    const card = await screen.findByRole("region", { name: RECIPIENTS_UPGRADE_LABEL });
    expect(card).toHaveTextContent(RECIPIENTS_LOCKED_PROMPT);
    expect(screen.queryByRole("textbox", { name: "Names or emails" })).toBeNull();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button"));
    expect(onUpgrade).toHaveBeenCalled();
  });

  it("turns a refusal for the plan into the upgrade card, not an error line", async () => {
    answer({
      share_recipient_links: () => view({ inPlan: null }),
      share_add_recipient_links: () => {
        throw { kind: "Validation", message: "Links per person are available on paid Drive plans." };
      },
    });
    render(<RecipientLinks shareToken="tok" onUpgrade={vi.fn()} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Names or emails" }), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("region", { name: RECIPIENTS_UPGRADE_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
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
    answer({ share_recipient_links: () => view({ people: [{ shareToken: "x", name: null, url: null, mailto: null, ndaPending: false }] }) });
    render(<RecipientLinks shareToken="tok" />);
    expect(await screen.findByText(UNNAMED_LINK)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy link/ })).toBeNull();
  });

  it("shows a link still waiting for its NDA with Try again instead of its link", async () => {
    const locked = { ...BOB, ndaPending: true };
    answer({ share_recipient_links: () => view({ people: [ALICE, locked] }), share_retry_recipient_nda: () => undefined });
    render(<RecipientLinks shareToken="tok" />);
    const row = (await screen.findByText(NDA_PENDING_NOTE)).closest("li")!;
    expect(within(row).queryByRole("button", { name: /Copy link/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Email link/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: COPY_ALL }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(`Alice: ${ALICE.url}`));

    fireEvent.click(within(row).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_retry_recipient_nda", { shareToken: "tok", recipientToken: "b" }),
    );
    await waitFor(() => expect(screen.queryByText(NDA_PENDING_NOTE)).toBeNull());
    expect(screen.getByRole("button", { name: "Copy link for bob@example.com" })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("NDA added to the link for bob@example.com");
  });

  it("keeps the link waiting and says why when Try again fails", async () => {
    answer({
      share_recipient_links: () => view({ people: [{ ...ALICE, ndaPending: true }] }),
      share_retry_recipient_nda: () => {
        throw { kind: "Validation", message: "This file's NDA text couldn't be found." };
      },
    });
    render(<RecipientLinks shareToken="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByText(NDA_PENDING_NOTE)).toBeInTheDocument();
  });

  it("marks a just-made link whose NDA could not be added, with Rust's sentence", async () => {
    answer({
      share_recipient_links: () => view({}),
      share_add_recipient_links: () => ({
        people: [{ ...ALICE, ndaPending: true }],
        left: "Carol",
        error: "The new link was made, but its NDA couldn't be added, so it won't open yet. Try again.",
      }),
    });
    render(<RecipientLinks shareToken="tok" />);
    const box = await screen.findByRole("textbox", { name: "Names or emails" });
    fireEvent.change(box, { target: { value: "Alice, Carol" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(NDA_PENDING_NOTE)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("its NDA couldn't be added");
    expect(box).toHaveValue("Carol");
  });
});

describe("recipient link helpers", () => {
  it("copies only the links known here, one per line", () => {
    expect(allLinksText([ALICE, { ...BOB, url: null }, { ...ALICE, shareToken: "c", name: null }])).toBe(
      `Alice: ${ALICE.url}\n${UNNAMED_LINK}: ${ALICE.url}`,
    );
  });

  it("leaves out a link that won't open until its NDA is added", () => {
    expect(allLinksText([ALICE, { ...BOB, ndaPending: true }])).toBe(`Alice: ${ALICE.url}`);
  });

  it("keeps a just-made link waiting for its NDA when the listing does not know yet", () => {
    expect(mergePeople([ALICE], [{ ...ALICE, ndaPending: true }])[0].ndaPending).toBe(true);
  });

  it("keeps a just-made link's URL when the listing has not caught up", () => {
    const listed = [{ ...ALICE, url: null }];
    expect(mergePeople(listed, [ALICE, BOB])).toEqual([ALICE, BOB]);
  });

  it("while the Drive is locked, the box says so with a lock, and after the unlock it is the real box", async () => {
    let unlocked = false;
    answer({ share_recipient_links: () => view({ canAdd: unlocked }) });
    store = createStore();
    store.set(syncRequiresReauthAtom, true);
    render(
      <Provider store={store}>
        <RecipientLinks shareToken="tok" />
      </Provider>,
    );
    const locked = await screen.findByTestId("recipient-links-locked");
    expect(locked).toHaveTextContent("Unlock your Drive to add people");
    expect(screen.queryByRole("textbox", { name: "Names or emails" })).toBeNull();
    fireEvent.click(locked);
    await waitFor(() => expect(unlockCalls.n).toBe(1));
    unlocked = true;
    await act(async () => {
      store.set(syncRequiresReauthAtom, false);
      store.set(activeRecoveryCheckAtom, null);
    });
    expect(await screen.findByRole("textbox", { name: "Names or emails" })).toBeInTheDocument();
    expect(screen.queryByTestId("recipient-links-locked")).toBeNull();
  });
});

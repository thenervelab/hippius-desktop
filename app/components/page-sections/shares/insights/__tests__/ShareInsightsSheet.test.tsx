import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";

import { MotionGlobalConfig } from "framer-motion";

import ShareInsightsSheet, { LINK_TURNED_OFF, LINK_TURNED_OFF_BODY, VERIFIED_EMAIL } from "../ShareInsightsSheet";
import { OFFLINE_LINE, UNREACHABLE_LINE } from "../insightsView";
import { DOWNLOAD_SWITCH } from "@/components/page-sections/drive/LinkEngagementSwitches";
import { GATE_LABEL } from "../EmailGateSettings";
import {
  LOCKED_ACTION,
  LOCKED_PROMPT,
  DOWNLOAD_LOCKED_PROMPT,
  DOWNLOAD_NOT_IN_PLAN,
  LOCK_BODY,
  LOCK_BODY_NOT_COUNTING,
  LOCK_BODY_STILL,
  LOCK_TITLE,
  LOCK_TITLE_STILL,
  PAGES_LOCK_BODY,
  PAGES_LOCK_TITLE,
  PRICING_URL,
  SAMPLE_PAGES,
  SAMPLE_LABEL,
  SAMPLE_UNIQUE_VIEWERS,
  SAMPLE_VIEWERS,
  SAMPLE_VIEWS,
} from "../insightsView";
import {
  insightsSheetAtom,
  serverCapabilitiesAtom,
  shareDriveModalAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";
import type { ShareComments, ShareInsights } from "@/app/lib/tauri/shareInsights";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const openUrl = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrl(...(a as [])) }));
// Signed out as far as the listing goes: the panel's listing keeper asks for
// nothing, so each test seeds the listing it needs.
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: null, authType: "mnemonic" }),
}));

// jsdom has no matchMedia: the panel is inline (a wide window) unless a test
// asks for the narrow one, where it is a sheet over the page.
const viewport = vi.hoisted(() => ({ wide: true }));
vi.mock("@/app/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks")>();
  return {
    ...actual,
    useBreakpoint: () => ({
      breakpoint: viewport.wide ? "xl" : "md",
      isMobile: false,
      isTablet: !viewport.wide,
      isLaptop: false,
      isDesktop: viewport.wide,
      isLargeDesktop: false,
    }),
  };
});
// The panel's open and close are instant, so a closed panel is gone at once.
MotionGlobalConfig.skipAnimations = true;

const FREE: ShareInsights = {
  plan: "free",
  totalViews: 2,
  uniqueViewers: 1,
  completion: { state: "locked" },
  retention: { state: "locked" },
  viewers: { state: "locked" },
};

const PAID: ShareInsights = {
  plan: "paid",
  totalViews: 5,
  uniqueViewers: 3,
  completion: { state: "shown", value: 0.25 },
  retention: { state: "shown", value: [100, 100, 98, 60] },
  viewers: {
    state: "shown",
    value: [
      { viewerId: "b", name: "Ahmad", visits: 2, watchedMs: 78_000, completion: 0.5, lastViewedAt: null, comments: 1, reactions: 0 },
      { viewerId: "a", name: null, visits: 1, watchedMs: 12_000, completion: 0.1, lastViewedAt: null, comments: 0, reactions: 0 },
    ],
  },
};

const COMMENTS: ShareComments = {
  comments: [
    { id: "c1", text: "Looks great at 1:23!", name: "Ahmad", atMs: 83_000, createdAt: "2026-10-13T10:00:00Z" },
    { id: "c2", text: "Nice", name: null, atMs: null, createdAt: "2026-10-13T10:00:00Z" },
  ],
  unreadable: null,
};

const CAPS: ServerCapabilities = {
  shares: true,
  folder_shares: true,
  folder_share_revoke_by_hash: true,
  share_owner_wrap: true,
  folder_grants: true,
  share_insights: true,
  share_comments: true,
};

const NAME = "Recording 2026-10-13.mp4";
const NO_COMMENTS = { comments: [], unreadable: null };
const NO_REACTIONS = { counts: [], total: 0 };
const ALL_ON = { insights: true, comments: true, reactions: true };

/** Answers IPC by command; a function answer is called with the arguments. */
function answer(map: Record<string, unknown>) {
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    if (!(cmd in map)) return Promise.reject(new Error(`unexpected ${cmd}`));
    const value = map[cmd];
    return Promise.resolve(typeof value === "function" ? value(args) : value);
  });
}

function renderSheet(caps: ServerCapabilities = CAPS, seed?: (client: QueryClient) => void, fileName: string = NAME) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, caps);
  store.set(insightsSheetAtom, { shareToken: "tok", fileName });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  render(
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <ShareInsightsSheet />
      </Provider>
    </QueryClientProvider>,
  );
  return store;
}

/** Opens a comment's menu the way Radix listens for it. */
async function openMenu(name: string) {
  const trigger = screen.getAllByRole("button", { name: `Comment actions for ${name}` })[0];
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByRole("menu");
}

/** Opens Link settings from the header's gear and returns the popover. */
async function openSettings() {
  fireEvent.click(await screen.findByRole("button", { name: "Link settings" }));
  return screen.findByRole("dialog", { name: "Link settings" });
}

/** Selects a tab by the start of its label ("Viewers", "Reactions") and returns its panel. */
/** The summary's number under one label (Views, Viewers, Comments, Watched), or null when that cell is not drawn. */
function stat(label: string): string | null {
  const summary = screen.getByRole("region", { name: "Summary" });
  const dt = within(summary).queryByText(label, { selector: "dt" });
  return dt?.parentElement?.querySelector("dd")?.textContent ?? null;
}

async function showTab(start: string) {
  const tab = await screen.findByRole("tab", { name: (name) => name.startsWith(start) });
  fireEvent.click(tab);
  expect(tab).toHaveAttribute("aria-selected", "true");
  return screen.getByRole("tabpanel");
}

const ALL_SWITCHES_ON = { offered: ALL_ON, on: ALL_ON, switchesInPlan: true };

describe("ShareInsightsSheet", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    push.mockReset();
    openUrl.mockClear();
    viewport.wide = true;
  });

  it("gives a free plan its two numbers and only sample data, blurred, behind the lock", async () => {
    answer({ share_get_insights: FREE, share_list_comments: { comments: [], unreadable: null } });
    const store = renderSheet();

    // No comments, so it opens on Viewers, which carries the lock.
    const locked = await screen.findByTestId("insights-locked");
    expect(screen.getByRole("tab", { name: "Viewers" })).toHaveAttribute("aria-selected", "true");
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(stat("Views")).toBe("2");
    expect(stat("Viewers")).toBe("1");
    // Completion is locked, so the third cell is the comments, not Watched.
    await waitFor(() => expect(stat("Comments")).toBe("0"));
    expect(stat("Watched")).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("share_get_insights", { shareToken: "tok" });

    const blurred = locked.firstElementChild as HTMLElement;
    expect(blurred).toHaveAttribute("aria-hidden", "true");
    expect(blurred).toHaveAttribute("inert");
    expect(blurred.className).toContain("blur");
    // What is drawn there is the made-up sample, never anything of the link's.
    expect(within(blurred).getByText(SAMPLE_VIEWERS[0].name!)).toBeInTheDocument();
    expect(within(blurred).getByText("68%")).toBeInTheDocument();
    // The summary draws nothing the plan does not include.
    expect(within(summary).queryByText("68%")).toBeNull();

    expect(within(locked).getByText(LOCK_TITLE)).toBeInTheDocument();
    expect(within(locked).getByText(LOCK_BODY)).toBeInTheDocument();
    // Labelled as a sample, outside the blur, so it is never read as the link's.
    const label = within(locked).getByTestId("insights-sample-label");
    expect(label).toHaveTextContent(SAMPLE_LABEL);
    expect(blurred.contains(label)).toBe(false);
    fireEvent.click(within(locked).getByRole("button", { name: "Compare plans" }));
    expect(openUrl).toHaveBeenCalledWith(PRICING_URL);
    fireEvent.click(within(locked).getByRole("button", { name: "Upgrade plan" }));
    expect(push).toHaveBeenCalledWith("/billing");
    expect(store.get(insightsSheetAtom)).toBeNull();
  });

  it("gives a picture's lock picture words and a sample with no watch time", async () => {
    answer({ share_get_insights: FREE, share_list_comments: NO_COMMENTS });
    renderSheet(CAPS, undefined, "Screenshot 2026-10-13.png");

    const locked = await screen.findByTestId("insights-locked");
    const blurred = locked.firstElementChild as HTMLElement;
    expect(within(locked).getByText(LOCK_TITLE_STILL)).toBeInTheDocument();
    expect(within(locked).getByText(LOCK_BODY_STILL)).toBeInTheDocument();
    expect(within(locked).queryByText(LOCK_TITLE)).toBeNull();
    expect(within(locked).getByTestId("insights-sample-label")).toHaveTextContent(SAMPLE_LABEL);
    // Who viewed, under sample names, and nothing about watching.
    expect(within(blurred).getByText(SAMPLE_VIEWERS[0].name!)).toBeInTheDocument();
    expect(within(blurred).queryByText("68%")).toBeNull();
    expect(within(blurred).queryByText("Average watch")).toBeNull();
    expect(within(blurred).queryByText("1:42")).toBeNull();
  });

  it("says comments are all included on the free plan", async () => {
    answer({ share_get_insights: FREE, share_list_comments: COMMENTS });
    renderSheet();
    expect(await screen.findByText("All included on your plan")).toBeInTheDocument();
  });

  it("shows a paid plan everything, with Anonymous viewer for a viewer who chose no name", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS });
    renderSheet();

    await screen.findByRole("region", { name: "Summary" });
    // A recording: Views, Viewers, and how much of it people watched.
    await waitFor(() => expect(stat("Watched")).toBe("25%"));
    expect(screen.queryByTestId("insights-locked")).toBeNull();
    expect(stat("Views")).toBe("5");
    expect(stat("Viewers")).toBe("3");
    expect(stat("Comments")).toBeNull();
    // Two comments: the tab it opens on.
    const tabs = screen.getByRole("tablist", { name: "Insights" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Comments 2",
      "Viewers 2",
      // Reactions did not load here, so no count is claimed.
      "Reactions",
    ]);
    expect(within(tabs).getByRole("tab", { name: "Comments 2" })).toHaveAttribute("aria-selected", "true");

    const viewers = await showTab("Viewers");
    expect(within(viewers).getByRole("heading", { name: "Where people stopped" })).toBeInTheDocument();
    expect(within(viewers).getByRole("group", { name: /Where people stopped\. 60% reached the end\./ })).toBeInTheDocument();
    expect(within(viewers).getAllByText("Ahmad").length).toBeGreaterThan(0);
    expect(within(viewers).getAllByText("Anonymous viewer").length).toBeGreaterThan(0);
    expect(within(viewers).getByText("2 visits")).toBeInTheDocument();
    expect(within(viewers).getByTitle("Watched 1:18")).toBeInTheDocument();
  });

  it("gives a picture's numbers as Views, Viewers and Comments, with no watch bars in its rows", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS });
    renderSheet(CAPS, undefined, "Screenshot 2026-10-13.png");
    await waitFor(() => expect(stat("Comments")).toBe("2"));
    expect(stat("Views")).toBe("5");
    expect(stat("Viewers")).toBe("3");
    expect(stat("Watched")).toBeNull();
    const viewers = await showTab("Viewers");
    expect(within(viewers).getAllByText("Anonymous viewer").length).toBeGreaterThan(0);
    expect(within(viewers).queryByTitle(/^Watched /)).toBeNull();
  });

  it("names the biggest drop over the chart", async () => {
    answer({ share_get_insights: PAID, share_list_comments: { comments: [], unreadable: null } });
    renderSheet();
    // [100, 100, 98, 60]: the fall to 60 is the last point; the length is
    // unknown here (no single-visit viewer covered 20%), so it reads as a share.
    expect(await screen.findByText("Most left at 100% in")).toBeInTheDocument();
  });

  it("reads the playhead from the keyboard", async () => {
    answer({ share_get_insights: PAID, share_list_comments: { comments: [], unreadable: null } });
    renderSheet();
    const chart = await screen.findByRole("group", { name: /Where people stopped/ });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "Home" });
    expect(screen.getAllByText("0% in · 100% still watching").length).toBeGreaterThan(0);
    fireEvent.keyDown(chart, { key: "End" });
    expect(screen.getAllByText("100% in · 60% still watching").length).toBeGreaterThan(0);
  });

  it("opens on Viewers when there are no comments, and keeps the tab the owner picks", async () => {
    answer({
      share_get_insights: PAID,
      share_list_comments: NO_COMMENTS,
      share_get_reactions: { counts: [{ emoji: "👍", count: 3 }], total: 3 },
    });
    renderSheet();
    expect(await screen.findByRole("tab", { name: "Viewers 2" })).toHaveAttribute("aria-selected", "true");
    const reactions = await showTab("Reactions 3");
    expect(within(reactions).getByRole("list", { name: "Reaction totals" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Viewers 2" })).toHaveAttribute("aria-selected", "false");
  });

  // A name keeps its LRM/RLM/ALM marks, which would otherwise reorder the
  // text after it in the same line (" · 2m ago"), so each name is isolated.
  it("isolates viewer and commenter names from the text around them", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS });
    renderSheet();

    expect(await screen.findByText("Looks great at 1:23!")).toBeInTheDocument();
    const names = screen.getAllByText("Ahmad");
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const name of names) expect(name.closest("bdi")).not.toBeNull();
    for (const anon of screen.getAllByText("Anonymous viewer")) expect(anon.closest("bdi")).not.toBeNull();
  });

  it("lists comments and deletes one only after asking in its row", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS, share_delete_comment: undefined });
    renderSheet();

    expect(await screen.findByText("Looks great at 1:23!")).toBeInTheDocument();
    // The moment it is about, beside who wrote it.
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "at 1:23")).toBeInTheDocument();
    await openMenu("Anonymous viewer");
    expect(await screen.findByText("Removes it for everyone.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete comment/ }));
    expect(screen.getByText("Delete this comment for everyone?")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("share_delete_comment", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_delete_comment", { shareToken: "tok", commentId: "c2" }),
    );
  });

  it("puts focus back on the comment's menu button when the question is cancelled", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS });
    renderSheet();
    expect(await screen.findByText("Nice")).toBeInTheDocument();
    await openMenu("Anonymous viewer");
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete comment/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Comment actions for Anonymous viewer" })[0]).toHaveFocus(),
    );
  });

  it("blocks a commenter only after asking, marks the row Blocked, and can undo it", async () => {
    answer({
      share_get_insights: PAID,
      share_list_comments: COMMENTS,
      share_block_commenter: undefined,
      share_unblock_commenter: undefined,
    });
    renderSheet();

    expect(await screen.findByText("Nice")).toBeInTheDocument();
    await openMenu("Anonymous viewer");
    expect(await screen.findByText("They can no longer comment or react on this link.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Block Anonymous viewer/ }));
    expect(screen.getByText(/Block them on this link\? They won't be able to comment or react here\./)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("share_block_commenter", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_block_commenter", { shareToken: "tok", commentId: "c2" }),
    );
    // Shown at once, before the list is read back.
    expect(await screen.findByText("Blocked")).toBeInTheDocument();
    // A blocked row's menu offers Delete only.
    await openMenu("Anonymous viewer");
    expect(await screen.findByRole("menuitem", { name: /Delete comment/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Block/ })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Unblock" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_unblock_commenter", { shareToken: "tok", commentId: "c2" }),
    );
    await waitFor(() => expect(screen.queryByText("Blocked")).toBeNull());
  });

  it("marks every comment of a person blocked through one of them, and reads the list again", async () => {
    const KEY = "q3LkV0Xp2b9nYt1sZx8wAg";
    const before: ShareComments = {
      comments: [
        { id: "c1", text: "First spam", name: "Sofia", atMs: null, createdAt: "2026-10-13T10:00:00Z", authorKey: KEY },
        { id: "c2", text: "Fair point", name: "Ada", atMs: null, createdAt: "2026-10-13T10:01:00Z", authorKey: "Zm9vYmFyYmF6cXV4cXV1dQ" },
        { id: "c3", text: "Second spam", name: "Sofia", atMs: null, createdAt: "2026-10-13T10:02:00Z", authorKey: KEY },
        { id: "c4", text: "Quiet one", name: null, atMs: null, createdAt: "2026-10-13T10:03:00Z" },
      ],
      unreadable: null,
    };
    // What the server lists after the block: every named comment of Sofia's.
    const after: ShareComments = {
      ...before,
      comments: before.comments.map((c) => (c.authorKey === KEY ? { ...c, blocked: true } : c)),
    };
    let listed = before;
    answer({
      share_get_insights: PAID,
      share_list_comments: () => listed,
      share_block_commenter: () => {
        listed = after;
        return undefined;
      },
    });
    renderSheet();

    expect(await screen.findByText("Second spam")).toBeInTheDocument();
    const reads = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "share_list_comments").length;
    const readsBefore = reads();
    await openMenu("Sofia");
    fireEvent.click(screen.getByRole("menuitem", { name: /Block Sofia/ }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    await waitFor(() => expect(screen.getAllByText("Blocked")).toHaveLength(2));
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore));
    const row = (text: string) => screen.getByText(text).closest("li")!;
    expect(within(row("First spam")).getByText("Blocked")).toBeInTheDocument();
    expect(within(row("Second spam")).getByText("Blocked")).toBeInTheDocument();
    expect(within(row("Fair point")).queryByText("Blocked")).toBeNull();
    expect(within(row("Quiet one")).queryByText("Blocked")).toBeNull();
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("shows the server's block marks, spread to all of the person's comments", async () => {
    answer({
      share_get_insights: PAID,
      share_list_comments: {
        comments: [
          { id: "c1", text: "First spam", name: "Sofia", atMs: null, createdAt: "2026-10-13T10:00:00Z", authorKey: "k1", blocked: true },
          { id: "c2", text: "Second spam", name: "Sofia", atMs: null, createdAt: "2026-10-13T10:01:00Z", authorKey: "k1" },
          { id: "c3", text: "Old block", name: null, atMs: null, createdAt: "2026-10-13T10:02:00Z", blocked: true },
          { id: "c4", text: "Fine", name: null, atMs: null, createdAt: "2026-10-13T10:03:00Z" },
        ],
        unreadable: null,
      } satisfies ShareComments,
      share_unblock_commenter: undefined,
    });
    renderSheet();

    expect(await screen.findByText("Fine")).toBeInTheDocument();
    expect(screen.getAllByText("Blocked")).toHaveLength(3);
    const row = (text: string) => screen.getByText(text).closest("li")!;
    expect(within(row("Fine")).queryByText("Blocked")).toBeNull();

    // Unblocking through either of Sofia's comments clears both.
    fireEvent.click(within(row("Second spam")).getByRole("button", { name: "Unblock" }));
    await waitFor(() => expect(screen.getAllByText("Blocked")).toHaveLength(1));
    expect(within(row("Old block")).getByText("Blocked")).toBeInTheDocument();
  });

  it("draws no replies or Owner badge until the server has replies", async () => {
    const withReply: ShareComments = {
      comments: [
        {
          ...COMMENTS.comments[0],
          replies: [{ id: "r1", text: "Thanks, fixed.", name: "Owner Name", createdAt: "2026-10-13T11:00:00Z", byOwner: true }],
        },
      ],
      unreadable: null,
    };
    answer({ share_get_insights: PAID, share_list_comments: withReply });
    renderSheet();
    expect(await screen.findByText("Looks great at 1:23!")).toBeInTheDocument();
    expect(screen.queryByText("Thanks, fixed.")).toBeNull();
    expect(screen.queryByText("Owner")).toBeNull();
  });

  it("draws replies with the Owner badge once the server has them", async () => {
    const withReply: ShareComments = {
      comments: [
        {
          ...COMMENTS.comments[0],
          replies: [{ id: "r1", text: "Thanks, fixed.", name: "Owner Name", createdAt: "2026-10-13T11:00:00Z", byOwner: true }],
        },
      ],
      unreadable: null,
    };
    answer({ share_get_insights: PAID, share_list_comments: withReply });
    renderSheet({ ...CAPS, share_comment_replies: true });
    expect(await screen.findByText("Thanks, fixed.")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("highlights @mentions, marks the ones about the owner, and filters to them", async () => {
    const mentioned: ShareComments = {
      comments: [
        {
          id: "m1",
          text: "@Owner can you share the slides?",
          name: "Ada",
          atMs: null,
          createdAt: "2026-10-13T10:00:00Z",
          mentions: [{ kind: "owner", name: "Owner", label: "Owner", you: true }],
          mentionsYou: true,
        },
        {
          id: "m2",
          text: "@Grace Liu agreed",
          name: "Bo",
          atMs: null,
          createdAt: "2026-10-13T11:00:00Z",
          mentions: [{ kind: "commenter", name: "Grace Liu", label: "Grace Liu", you: false }],
          mentionsYou: false,
        },
        { id: "m3", text: "No tags", name: "Cy", atMs: null, createdAt: "2026-10-13T12:00:00Z" },
      ],
      unreadable: null,
    };
    answer({ share_get_insights: PAID, share_list_comments: mentioned });
    renderSheet();
    const chip = (await screen.findByText("@Owner")).closest("[data-mention]");
    expect(chip).toHaveAttribute("data-mention-you", "true");
    expect(screen.getByText("@Grace Liu").closest("[data-mention]")).not.toHaveAttribute("data-mention-you");
    expect(screen.getAllByTestId("mentioned-you")).toHaveLength(1);

    const filter = screen.getByTestId("mentions-filter");
    expect(filter).toHaveTextContent("Mentions you1");
    expect(screen.getAllByTestId("comment-thread")).toHaveLength(3);
    fireEvent.click(filter);
    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("comment-thread")).toHaveLength(1);
    fireEvent.click(filter);
    expect(screen.getAllByTestId("comment-thread")).toHaveLength(3);
  });

  it("offers no mentions filter when nobody mentioned the owner", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS });
    renderSheet();
    expect(await screen.findByText("Looks great at 1:23!")).toBeInTheDocument();
    expect(screen.queryByTestId("mentions-filter")).toBeNull();
  });

  it("shows the reaction totals as bars, and that viewers don't see them while Reactions is off", async () => {
    answer({
      share_get_insights: PAID,
      share_list_comments: { comments: [], unreadable: null },
      share_get_reactions: {
        counts: [
          { emoji: "🔥", count: 1 },
          { emoji: "👍", count: 3 },
        ],
        total: 4,
      },
      share_get_link_settings: {
        offered: { insights: true, comments: true, reactions: true },
        on: { insights: true, comments: true, reactions: false },
      },
    });
    renderSheet();

    await screen.findByRole("region", { name: "Summary" });
    const tab = await showTab("Reactions 4");
    const totals = within(tab).getByRole("list", { name: "Reaction totals" });
    // Most first, as bars.
    expect(within(totals).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "👍3 reactions",
      "🔥1 reaction",
    ]);
    expect(await within(tab).findByText(/Reactions are off, so viewers don't see these/)).toBeInTheDocument();
    // Turn on opens Link settings, where the switch is.
    fireEvent.click(within(tab).getByRole("button", { name: "Turn on" }));
    const settings = await screen.findByRole("dialog", { name: "Link settings" });
    expect(within(settings).getByRole("switch", { name: "Reactions" })).toHaveAttribute("aria-checked", "false");
  });

  it("changes a link switch at once and puts it back when the server refuses", async () => {
    let settingsCalls = 0;
    // The server's switches: a change it takes is what the next read shows.
    let on = { insights: true, comments: false, reactions: true };
    invokeMock.mockImplementation((cmd: string, args?: { change?: Partial<typeof on> }) => {
      if (cmd === "share_get_insights") return Promise.resolve(PAID);
      if (cmd === "share_list_comments") return Promise.resolve({ comments: [], unreadable: null });
      if (cmd === "share_get_reactions") return Promise.resolve({ counts: [], total: 0 });
      if (cmd === "share_get_link_settings")
        return Promise.resolve({ offered: { insights: true, comments: true, reactions: true }, on });
      if (cmd === "share_set_link_settings") {
        settingsCalls += 1;
        if (settingsCalls !== 1) return Promise.reject({ kind: "Api", message: "nope" });
        on = { ...on, ...args?.change };
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    renderSheet();

    expect(await screen.findByTestId("insights-subtitle")).toHaveTextContent(/^Comments off$/);
    const settings = await openSettings();
    const comments = await within(settings).findByRole("switch", { name: "Comments" });
    expect(comments).toHaveAttribute("aria-checked", "false");
    comments.focus();
    fireEvent.click(comments);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", {
        shareToken: "tok",
        change: { comments: true },
      }),
    );
    expect(screen.getByRole("switch", { name: "Comments" })).toHaveAttribute("aria-checked", "true");
    // Saving re-renders the popover; focus stays on the switch.
    await waitFor(() => expect(screen.getByRole("switch", { name: "Comments" })).not.toBeDisabled());
    expect(screen.getByRole("switch", { name: "Comments" })).toHaveFocus();
    // The header's line follows the switch.
    await waitFor(() => expect(screen.queryByTestId("insights-subtitle")).toBeNull());

    fireEvent.click(screen.getByRole("switch", { name: "Insights" }));
    await waitFor(() => expect(settingsCalls).toBe(2));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Insights" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.queryByTestId("insights-subtitle")).toBeNull();
  });

  describe("on the free plan", () => {
    const ALL = { insights: true, comments: true, reactions: true };
    function freeLink(start: { insights: boolean; comments: boolean; reactions: boolean }) {
      let on = start;
      invokeMock.mockImplementation((cmd: string, args?: { change?: Partial<typeof on> }) => {
        if (cmd === "share_get_insights") return Promise.resolve({ ...FREE, totalViews: 0, uniqueViewers: 0 });
        if (cmd === "share_list_comments") return Promise.resolve({ comments: [], unreadable: null });
        if (cmd === "share_get_reactions") return Promise.resolve({ counts: [], total: 0 });
        if (cmd === "share_get_link_settings") return Promise.resolve({ offered: ALL, on, switchesInPlan: false });
        if (cmd === "share_set_link_settings") {
          on = { ...on, ...args?.change };
          return Promise.resolve();
        }
        return Promise.reject(new Error(`unexpected ${cmd}`));
      });
    }

    it("draws a link that is not counting views from samples only, under the lock", async () => {
      freeLink({ insights: false, comments: true, reactions: true });
      renderSheet();

      const locked = await screen.findByTestId("insights-locked");
      const blurred = locked.firstElementChild as HTMLElement;
      await waitFor(() => expect(within(blurred).getByText(String(SAMPLE_VIEWS))).toBeInTheDocument());
      expect(within(blurred).getByText(`${SAMPLE_UNIQUE_VIEWERS} people viewed`)).toBeInTheDocument();
      // No "0 views" outside the lock: nothing is being counted, and it says so.
      expect(screen.queryByText("0")).toBeNull();
      expect(within(screen.getByRole("region", { name: "Summary" })).getByText("Not counting views")).toBeInTheDocument();
      expect(within(locked).getByText(LOCK_BODY_NOT_COUNTING)).toBeInTheDocument();
    });

    it("shows the upgrade prompt when a switch is turned on, and sends nothing", async () => {
      freeLink({ insights: false, comments: false, reactions: false });
      const store = renderSheet();

      const settings = await openSettings();
      const insights = await within(settings).findByRole("switch", { name: "Insights" });
      expect(within(settings).getByText("Count views and watch time. On paid Drive plans.")).toBeInTheDocument();
      expect(within(settings).getByText("Let viewers comment on this link. On paid Drive plans.")).toBeInTheDocument();
      expect(within(settings).getByText("Let viewers react with emoji. On paid Drive plans.")).toBeInTheDocument();
      fireEvent.click(insights);
      expect(insights).toHaveAttribute("aria-checked", "false");
      const prompt = within(settings).getByRole("region", { name: "Upgrade for Insights, comments and reactions" });
      expect(within(prompt).getByText(LOCKED_PROMPT)).toBeInTheDocument();
      expect(LOCKED_PROMPT).toBe("Insights, comments and reactions are available on paid Drive plans");

      for (const name of ["Comments", "Reactions"]) {
        fireEvent.click(screen.getByRole("switch", { name }));
        expect(screen.getByRole("switch", { name })).toHaveAttribute("aria-checked", "false");
      }
      expect(invokeMock).not.toHaveBeenCalledWith("share_set_link_settings", expect.anything());

      fireEvent.click(within(prompt).getByRole("button", { name: LOCKED_ACTION }));
      expect(push).toHaveBeenCalledWith("/billing");
      expect(store.get(insightsSheetAtom)).toBeNull();
    });

    it("lets a link that already has comments and reactions on turn them off, but not back on", async () => {
      freeLink({ insights: false, comments: true, reactions: true });
      renderSheet();

      const settings = await openSettings();
      const comments = await within(settings).findByRole("switch", { name: "Comments" });
      expect(comments).toHaveAttribute("aria-checked", "true");
      fireEvent.click(comments);
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", {
          shareToken: "tok",
          change: { comments: false },
        }),
      );
      await waitFor(() => expect(screen.getByRole("switch", { name: "Reactions" })).not.toBeDisabled());
      fireEvent.click(screen.getByRole("switch", { name: "Reactions" }));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", {
          shareToken: "tok",
          change: { reactions: false },
        }),
      );
      await waitFor(() => expect(screen.getByRole("switch", { name: "Comments" })).toHaveAttribute("aria-checked", "false"));
      expect(screen.queryByText(LOCKED_PROMPT)).toBeNull();
    });

    it("leaves a link that already has Insights on as it is, and lets it turn them off", async () => {
      freeLink(ALL);
      renderSheet();

      // Its real counts are shown, not samples.
      await screen.findByRole("region", { name: "Summary" });
      expect(stat("Views")).toBe("0");
      expect(stat("Viewers")).toBe("0");
      const settings = await openSettings();
      const insights = await within(settings).findByRole("switch", { name: "Insights" });
      expect(insights).toHaveAttribute("aria-checked", "true");
      fireEvent.click(insights);
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", {
          shareToken: "tok",
          change: { insights: false },
        }),
      );
    });
  });

  it("offers Ask for email in Link settings only where Rust says the server has email gates", async () => {
    const gate = { offered: true, on: true, allowCount: 0, blockCount: 0, lists: { allow: [], block: [] }, inPlan: true };
    answer({
      share_get_insights: PAID,
      share_list_comments: NO_COMMENTS,
      share_get_reactions: NO_REACTIONS,
      share_get_link_settings: { offered: ALL_ON, on: ALL_ON, switchesInPlan: true },
      share_get_gate: gate,
    });
    renderSheet();
    const settings = await openSettings();
    const ask = await within(settings).findByRole("switch", { name: GATE_LABEL });
    expect(ask).toHaveAttribute("aria-checked", "true");
    expect(within(settings).getByRole("textbox", { name: "Only allow" })).toBeInTheDocument();
  });

  it("has no Ask for email on a server without email gates", async () => {
    answer({
      share_get_insights: PAID,
      share_list_comments: NO_COMMENTS,
      share_get_reactions: NO_REACTIONS,
      share_get_link_settings: { offered: ALL_ON, on: ALL_ON, switchesInPlan: true },
      share_get_gate: { offered: false, on: false, allowCount: 0, blockCount: 0, lists: null, inPlan: null },
    });
    renderSheet();
    const settings = await openSettings();
    await within(settings).findByRole("switch", { name: "Insights" });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_get_gate", { shareToken: "tok" }));
    expect(within(settings).queryByRole("switch", { name: GATE_LABEL })).toBeNull();
  });

  describe("Allow download", () => {
    const ALL = { insights: true, comments: true, reactions: true };
    function link({ plan, download, refuse = false }: { plan: boolean; download?: boolean | null; refuse?: boolean }) {
      let current = download;
      invokeMock.mockImplementation((cmd: string, args?: { change?: { download?: boolean } }) => {
        if (cmd === "share_get_insights") return Promise.resolve(plan ? PAID : { ...FREE, totalViews: 0, uniqueViewers: 0 });
        if (cmd === "share_list_comments") return Promise.resolve({ comments: [], unreadable: null });
        if (cmd === "share_get_reactions") return Promise.resolve({ counts: [], total: 0 });
        if (cmd === "share_get_link_settings")
          return Promise.resolve({ offered: ALL, on: ALL, switchesInPlan: plan, download: current });
        if (cmd === "share_set_link_settings") {
          if (refuse) return Promise.reject({ kind: "Validation", message: DOWNLOAD_NOT_IN_PLAN });
          current = args?.change?.download ?? current;
          return Promise.resolve();
        }
        return Promise.reject(new Error(`unexpected ${cmd}`));
      });
    }

    it("is not drawn on a server without the switch", async () => {
      link({ plan: true, download: null });
      renderSheet();
      const settings = await openSettings();
      await within(settings).findByRole("switch", { name: "Insights" });
      expect(within(settings).queryByRole("switch", { name: "Allow download" })).toBeNull();
    });

    it("turns downloads off on a paid plan, sending only that switch", async () => {
      link({ plan: true, download: true });
      renderSheet();
      const settings = await openSettings();
      const allow = await within(settings).findByRole("switch", { name: "Allow download" });
      expect(allow).toHaveAttribute("aria-checked", "true");
      fireEvent.click(allow);
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", { shareToken: "tok", change: { download: false } }),
      );
      await waitFor(() => expect(screen.getByRole("switch", { name: "Allow download" })).toHaveAttribute("aria-checked", "false"));
    });

    it("shows the upgrade prompt on the free plan instead of turning it off", async () => {
      link({ plan: false, download: true });
      renderSheet();
      const settings = await openSettings();
      const allow = await within(settings).findByRole("switch", { name: "Allow download" });
      expect(within(settings).getByText(DOWNLOAD_SWITCH.locked)).toBeInTheDocument();
      fireEvent.click(allow);
      expect(allow).toHaveAttribute("aria-checked", "true");
      const prompt = within(settings).getByRole("region", { name: "Upgrade to turn off downloads" });
      expect(within(prompt).getByText(DOWNLOAD_LOCKED_PROMPT)).toBeInTheDocument();
      expect(invokeMock).not.toHaveBeenCalledWith("share_set_link_settings", expect.anything());
    });

    it("shows the upgrade prompt when the server refuses it for the plan", async () => {
      link({ plan: true, download: true, refuse: true });
      renderSheet();
      const settings = await openSettings();
      fireEvent.click(await within(settings).findByRole("switch", { name: "Allow download" }));
      expect(await within(settings).findByRole("region", { name: "Upgrade to turn off downloads" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("switch", { name: "Allow download" })).toHaveAttribute("aria-checked", "true"));
    });
  });

  it("says why comments cannot be read, and marks one that did not open", async () => {
    answer({
      share_get_insights: PAID,
      share_list_comments: {
        comments: [{ id: "c1", text: null, name: null, atMs: null, createdAt: "2026-10-13T10:00:00Z" }],
        unreadable: "This link has a password, so its comments can only be read on the link's page.",
      },
    });
    renderSheet();

    expect(await screen.findByText(/This link has a password/)).toBeInTheDocument();
    expect(screen.getByText("This comment couldn't be read.")).toBeInTheDocument();
  });

  it("asks for no comments on a server without them", async () => {
    answer({ share_get_insights: PAID });
    renderSheet({ ...CAPS, share_comments: false });

    await waitFor(() => expect(stat("Watched")).toBe("25%"));
    // Viewers is then the only tab, so it is drawn without a tab list.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("list", { name: "Viewers" })).toBeInTheDocument();
    expect(screen.queryByText(/Comments/)).toBeNull();
    expect(screen.queryByText(/Reactions/)).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("share_list_comments", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("share_get_reactions", expect.anything());
  });

  it("explains each number on request, inside Link settings", async () => {
    answer({ share_get_insights: PAID, share_list_comments: { comments: [], unreadable: null } });
    renderSheet();
    await screen.findByText("25%");
    expect(screen.queryByText("How we count views")).toBeNull();
    const settings = await openSettings();
    // Settings that fail to load say so, with Try again; the explanation is
    // there either way.
    expect(await within(settings).findByText(UNREACHABLE_LINE)).toBeInTheDocument();
    expect(within(settings).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(within(settings).getByText("How we count views")).toBeInTheDocument();
    expect(within(settings).getByText("Each time the link is opened.")).toBeInTheDocument();
  });

  describe("Link settings and the header's line", () => {
    const SOME_OFF = { offered: ALL_ON, on: { insights: true, comments: false, reactions: true }, switchesInPlan: true };

    it("says a switch that is off in the header's line, with no row of switch badges", async () => {
      answer({
        share_get_insights: PAID,
        share_list_comments: COMMENTS,
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: SOME_OFF,
      });
      renderSheet();
      expect(await screen.findByTestId("insights-subtitle")).toHaveTextContent(/^Comments off$/);
      expect(screen.queryByRole("list", { name: "On this link" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Change in Link settings/ })).toBeNull();
      // The header is the name, its line, the gear and Close: no thumbnail,
      // no second Copy.
      const header = screen.getByTestId("insights-panel").querySelector("header")!;
      expect(screen.queryByTestId("insights-media-tile")).toBeNull();
      expect(within(header).getByRole("button", { name: "Link settings" })).toBeInTheDocument();
      expect(within(header).getByRole("button", { name: "Close" })).toBeInTheDocument();
      expect(within(header).queryByRole("button", { name: /Copy link/ })).toBeNull();
    });

    it("says a free plan's link has every switch off, with the lock and the gear still there", async () => {
      answer({
        share_get_insights: FREE,
        share_list_comments: COMMENTS,
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: { offered: ALL_ON, on: { insights: false, comments: false, reactions: false }, switchesInPlan: false },
      });
      renderSheet();
      expect(await screen.findByTestId("insights-subtitle")).toHaveTextContent(/^Insights, comments and reactions off$/);
      // The plan's lock stays where it was, in the Viewers tab, and Link
      // settings still opens from the gear.
      fireEvent.click(screen.getByRole("tab", { name: /Viewers/ }));
      expect(await screen.findByTestId("insights-locked")).toBeInTheDocument();
      const settings = await openSettings();
      expect(within(settings).getAllByRole("switch")).toHaveLength(3);
    });

    it("opens from the gear, closes on Escape without closing the panel, and gives focus back", async () => {
      answer({
        share_get_insights: PAID,
        share_list_comments: COMMENTS,
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: ALL_SWITCHES_ON,
      });
      const store = renderSheet();

      const gear = await screen.findByRole("button", { name: "Link settings" });
      expect(gear).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(gear);
      const settings = await screen.findByRole("dialog", { name: "Link settings" });
      expect(gear).toHaveAttribute("aria-expanded", "true");
      expect(within(settings).getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual([
        "Insights",
        "Comments",
        "Reactions",
      ]);
      await waitFor(() => expect(within(settings).getByRole("heading", { name: "Link settings" })).toHaveFocus());

      fireEvent.keyDown(within(settings).getByRole("heading", { name: "Link settings" }), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link settings" })).toBeNull());
      expect(store.get(insightsSheetAtom)).not.toBeNull();
      await waitFor(() => expect(gear).toHaveFocus());

      // A press outside closes it.
      fireEvent.click(gear);
      expect(await screen.findByRole("dialog", { name: "Link settings" })).toBeInTheDocument();
      fireEvent.pointerDown(screen.getByRole("heading", { level: 2 }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link settings" })).toBeNull());

      // The gear toggles it closed too.
      fireEvent.click(gear);
      expect(await screen.findByRole("dialog", { name: "Link settings" })).toBeInTheDocument();
      fireEvent.pointerDown(gear);
      fireEvent.click(gear);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link settings" })).toBeNull());
    });

    it("says in the Comments tab that comments are off, with Turn on, and still lists what is there", async () => {
      let link = SOME_OFF;
      answer({
        share_get_insights: PAID,
        share_list_comments: COMMENTS,
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: () => link,
        share_set_link_settings: ({ change }: { change: Partial<typeof ALL_ON> }) => {
          link = { ...link, on: { ...link.on, ...change } };
        },
      });
      renderSheet();
      const notice = await screen.findByText("Comments are off, so viewers can't add new ones.");
      expect(screen.getByText("Looks great at 1:23!")).toBeInTheDocument();
      fireEvent.click(within(notice.parentElement!).getByRole("button", { name: "Turn on" }));
      const settings = await screen.findByRole("dialog", { name: "Link settings" });
      fireEvent.click(within(settings).getByRole("switch", { name: "Comments" }));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", {
          shareToken: "tok",
          change: { comments: true },
        }),
      );
      await waitFor(() => expect(screen.queryByText("Comments are off, so viewers can't add new ones.")).toBeNull());
    });

    it("says in the Viewers tab that views are not being counted", async () => {
      answer({
        share_get_insights: PAID,
        share_list_comments: NO_COMMENTS,
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: { ...SOME_OFF, on: { ...ALL_ON, insights: false } },
      });
      renderSheet();
      expect(await screen.findByText("Insights are off, so new views aren't counted.")).toBeInTheDocument();
      // What was counted before stays.
      expect(screen.getAllByText("Ahmad").length).toBeGreaterThan(0);
    });
  });

  describe("a link with many comments", () => {
    const LONG_NAME = "Maximiliana Wolfeschlegelsteinhausenbergerdorff-Rivers";
    /** Comment i was written i hours after the first, so "Comment 21" is the newest. */
    const many = (n: number): ShareComments => ({
      comments: Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        text: `Comment ${i}`,
        name: i === 0 ? LONG_NAME : `Person ${i}`,
        atMs: null,
        createdAt: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 3_600_000).toISOString(),
      })),
      unreadable: null,
    });

    const threads = () => screen.getAllByTestId("comment-thread");
    const firstText = () => within(threads()[0]).getByText(/^Comment \d+$/).textContent;

    it("lists ten threads at a time, newest first, and loads the rest on request", async () => {
      answer({
        share_get_insights: PAID,
        share_list_comments: many(22),
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: ALL_SWITCHES_ON,
      });
      renderSheet();
      expect(await screen.findByRole("tab", { name: "Comments 22" })).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(threads()).toHaveLength(10));
      expect(firstText()).toBe("Comment 21");
      expect(screen.getByText("10 of 22")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Show more comments" }));
      expect(threads()).toHaveLength(20);
      fireEvent.click(screen.getByRole("button", { name: "Show more comments" }));
      expect(threads()).toHaveLength(22);
      expect(screen.queryByRole("button", { name: "Show more comments" })).toBeNull();
    });

    it("sorts Newest or Oldest first", async () => {
      answer({ share_get_insights: PAID, share_list_comments: many(12), share_get_reactions: NO_REACTIONS });
      renderSheet();
      const sort = await screen.findByRole("group", { name: "Sort comments" });
      expect(within(sort).getByRole("button", { name: "Newest" })).toHaveAttribute("aria-pressed", "true");
      expect(firstText()).toBe("Comment 11");
      fireEvent.click(within(sort).getByRole("button", { name: "Oldest" }));
      expect(within(sort).getByRole("button", { name: "Oldest" })).toHaveAttribute("aria-pressed", "true");
      expect(firstText()).toBe("Comment 0");
      // Still ten at a time.
      expect(threads()).toHaveLength(10);
    });

    it("shows two replies and folds the rest behind Show N more replies", async () => {
      const thread: ShareComments = {
        comments: [
          {
            ...COMMENTS.comments[0],
            replies: Array.from({ length: 5 }, (_, i) => ({
              id: `r${i}`,
              text: `Reply ${i}`,
              name: `Replier ${i}`,
              createdAt: "2026-10-13T11:00:00Z",
              byOwner: false,
            })),
          },
        ],
        unreadable: null,
      };
      answer({ share_get_insights: PAID, share_list_comments: thread, share_get_reactions: NO_REACTIONS });
      renderSheet({ ...CAPS, share_comment_replies: true });
      expect(await screen.findByText("Reply 0")).toBeInTheDocument();
      expect(screen.getAllByTestId("comment-reply")).toHaveLength(2);
      expect(screen.queryByText("Reply 2")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Show 3 more replies" }));
      expect(screen.getAllByTestId("comment-reply")).toHaveLength(5);
      expect(screen.getByText("Reply 4")).toBeInTheDocument();
    });

    it("clamps a long comment to four lines with Show more, only when it is cut", async () => {
      // jsdom has no layout: a long comment reports more height than four lines.
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-clamped-text") && this.textContent!.length > 40 ? 200 : 0;
      });
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-clamped-text") ? (this.className.includes("line-clamp-4") ? 76 : 200) : 0;
      });
      try {
        const long = "This is a long comment that goes on and on about the recording. ".repeat(6).trim();
        answer({
          share_get_insights: PAID,
          share_list_comments: { comments: [{ ...COMMENTS.comments[0], text: long }, COMMENTS.comments[1]], unreadable: null },
          share_get_reactions: NO_REACTIONS,
        });
        renderSheet();
        const text = await screen.findByText(long);
        expect(text.className).toContain("line-clamp-4");
        // Only the long one carries the button.
        const more = screen.getByRole("button", { name: "Show more" });
        expect(screen.getAllByRole("button", { name: /^Show (more|less)$/ })).toHaveLength(1);
        expect(more).toHaveAttribute("aria-expanded", "false");
        fireEvent.click(more);
        expect(text.className).not.toContain("line-clamp-4");
        expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("cuts a long name in the middle, keeping its start and end, with the full name in its title", async () => {
      // jsdom has no layout or canvas: every character 8px, every name 120px wide.
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-middle-truncate") ? 120 : 0;
      });
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
        return [...(this.getAttribute("data-text") ?? this.textContent ?? "")].length * 8;
      });
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        () => ({ font: "", measureText: (t: string) => ({ width: [...t].length * 8 }) }) as unknown as CanvasRenderingContext2D,
      );
      try {
        answer({
          share_get_insights: {
            ...PAID,
            viewers: { state: "shown", value: [{ ...PAID.viewers.state === "shown" ? PAID.viewers.value[0] : ({} as never), name: LONG_NAME }] },
          },
          share_list_comments: many(1),
          share_get_reactions: NO_REACTIONS,
        });
        renderSheet();
        await screen.findByRole("tab", { name: "Comments 1" });
        const boxes = await waitFor(() => {
          const found = Array.from(document.querySelectorAll<HTMLElement>("[data-middle-truncate]")).filter(
            (el) => el.getAttribute("title") === LONG_NAME,
          );
          expect(found.length).toBeGreaterThanOrEqual(2); // the comment row and the viewer row
          return found;
        });
        for (const box of boxes) {
          const line = box.firstElementChild!.textContent!;
          expect(line).toContain("…");
          expect(line.length).toBeLessThanOrEqual(15);
          expect(line.startsWith("Maxi")).toBe(true);
          expect(line.endsWith(LONG_NAME.slice(-3))).toBe(true);
          expect(box).toHaveAttribute("data-shortened");
          // A screen reader hears the whole name.
          expect(within(box).getByText(LONG_NAME, { selector: ".sr-only" })).toBeInTheDocument();
        }
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("a link nothing has happened on yet", () => {
    const EMPTY = { ...PAID, totalViews: 0, uniqueViewers: 0, viewers: { state: "shown" as const, value: [] } };

    it("shows its zeros and one short line in the tab, with no helper sentence", async () => {
      answer({
        share_get_insights: EMPTY,
        share_list_comments: NO_COMMENTS,
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: ALL_SWITCHES_ON,
      });
      renderSheet();

      const viewers = await showTab("Viewers 0");
      expect(within(viewers).getByText("No views yet")).toBeInTheDocument();
      expect(stat("Views")).toBe("0");
      expect(stat("Viewers")).toBe("0");
      expect(screen.queryByText(/Nobody has opened this link yet/)).toBeNull();
      expect(screen.queryByText(/Views show up here/)).toBeNull();
      expect(screen.getByRole("button", { name: "Link settings" })).toBeInTheDocument();
      expect(within(await showTab("Comments 0")).getByText("No comments yet")).toBeInTheDocument();
      expect(within(await showTab("Reactions 0")).getByText("No reactions yet")).toBeInTheDocument();
    });

    it("says the link is not counting views when its Insights switch is off, with Turn on", async () => {
      answer({
        share_get_insights: EMPTY,
        share_list_comments: NO_COMMENTS,
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: { offered: ALL_ON, on: { ...ALL_ON, insights: false }, switchesInPlan: true },
      });
      renderSheet();
      expect(await screen.findByTestId("insights-subtitle")).toHaveTextContent("Insights off");
      const viewers = await showTab("Viewers");
      expect(await within(viewers).findByText("Insights are off, so new views aren't counted.")).toBeInTheDocument();
      fireEvent.click(within(viewers).getByRole("button", { name: "Turn on" }));
      expect(await screen.findByRole("dialog", { name: "Link settings" })).toBeInTheDocument();
    });

    it("shows the numbers it has while comments load, holding only their count", async () => {
      invokeMock.mockImplementation((cmd: string) =>
        cmd === "share_get_insights" ? Promise.resolve(EMPTY) : new Promise(() => {}),
      );
      renderSheet(CAPS, undefined, "Screenshot 2026-10-13.png");
      await waitFor(() => expect(stat("Views")).toBe("0"));
      expect(stat("Comments")).toBe("");
      expect(screen.queryByTestId("insights-loading")).toBeNull();
    });

    it("keeps one line for no views once there are comments", async () => {
      answer({
        share_get_insights: EMPTY,
        share_list_comments: COMMENTS,
        share_get_reactions: NO_REACTIONS,
      });
      renderSheet(CAPS, undefined, "Screenshot 2026-10-13.png");
      expect(await screen.findByText("Looks great at 1:23!")).toBeInTheDocument();
      expect(stat("Views")).toBe("0");
      expect(stat("Comments")).toBe("2");
      const viewers = await showTab("Viewers");
      expect(within(viewers).getByText("No views yet")).toBeInTheDocument();
      const reactions = await showTab("Reactions");
      expect(within(reactions).getByText("No reactions yet")).toBeInTheDocument();
    });
  });

  it("holds the layout with a skeleton while loading", () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    renderSheet();
    expect(screen.getByTestId("insights-loading")).toHaveAttribute("aria-busy", "true");
  });

  it("puts the share date and the link state in the header", async () => {
    answer({ share_get_insights: PAID, share_list_comments: { comments: [], unreadable: null } });
    renderSheet(CAPS, (client) =>
      client.setQueryData(
        ["shares-list", "5Acct"],
        [{ shareToken: "tok", createdAt: "2026-10-20T10:00:00Z", expiresAt: null }],
      ),
    );
    expect(await screen.findByText(/^Shared Oct 20(, 2026)? · link on$/)).toBeInTheDocument();
  });

  it("never shows a request's own text, and offers Try again wherever something did not load", async () => {
    let fail = true;
    const transport = { kind: "Hcfs", message: "insights failed: error sending request for url (https://x/v1/shares/tok/insights)" };
    invokeMock.mockImplementation((cmd: string) => {
      if (fail) return Promise.reject(transport);
      if (cmd === "share_get_insights") return Promise.resolve(PAID);
      if (cmd === "share_list_comments") return Promise.resolve({ comments: [], unreadable: null });
      if (cmd === "share_get_reactions") return Promise.resolve({ counts: [], total: 0 });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    renderSheet();
    const summary = await screen.findByRole("region", { name: "Summary" });
    expect(await within(summary).findByText(UNREACHABLE_LINE)).toBeInTheDocument();
    // The Comments tab (and the hidden Reactions tab) say the same, each
    // with its own Try again.
    expect(await screen.findAllByText(UNREACHABLE_LINE)).toHaveLength(3);
    expect(screen.queryByText(/error sending request/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(2);

    fail = false;
    const body = screen.getByTestId("insights-body");
    fireEvent.click(within(body).getByRole("button", { name: "Try again" }));
    expect(await within(body).findByText("No comments yet")).toBeInTheDocument();
  });

  it("says when this computer is offline, instead of loading for ever", async () => {
    // Offline, TanStack pauses network queries; the panel's are IPC calls
    // Rust answers anyway, so they must still run and reach the line.
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    onlineManager.setOnline(false);
    try {
      invokeMock.mockImplementation(() => Promise.reject({ kind: "Validation", message: "Couldn't reach Hippius. Try again." }));
      renderSheet();
      const summary = await screen.findByRole("region", { name: "Summary" });
      expect(await within(summary).findByText(OFFLINE_LINE)).toBeInTheDocument();
    } finally {
      online.mockRestore();
      onlineManager.setOnline(true);
    }
  });

  it("shows the share date once the listing arrives, as after Create link", async () => {
    answer({ share_get_insights: PAID, share_list_comments: { comments: [], unreadable: null } });
    let client: QueryClient | null = null;
    renderSheet(CAPS, (c) => {
      client = c;
    });
    await screen.findByRole("region", { name: "Summary" });
    expect(screen.queryByText(/^Shared /)).toBeNull();
    // The listing Create link asked for comes back with the new link.
    act(() => {
      client!.setQueryData(["shares-list", "5Acct"], [{ shareToken: "tok", createdAt: "2026-10-20T10:00:00Z", expiresAt: null }]);
    });
    expect(await screen.findByText(/^Shared Oct 20(, 2026)? · link on$/)).toBeInTheDocument();
  });

  it("says the link is turned off when it is revoked while the panel is open", async () => {
    answer({
      share_get_insights: PAID,
      share_list_comments: { comments: [], unreadable: null },
      share_get_reactions: NO_REACTIONS,
      share_get_link_settings: { offered: ALL_ON, on: ALL_ON, switchesInPlan: true },
    });
    let client: QueryClient | null = null;
    renderSheet(CAPS, (c) => {
      client = c;
      c.setQueryData(["shares-list", "5Acct"], [{ shareToken: "tok", createdAt: "2026-10-20T10:00:00Z", expiresAt: null }]);
    });
    await screen.findByRole("region", { name: "Summary" });
    expect(screen.getByRole("button", { name: "Link settings" })).toBeInTheDocument();
    // Shared Links revokes it, and reads the listing again.
    act(() => {
      client!.setQueryData(["shares-list", "5Acct"], []);
    });
    expect(await screen.findAllByText(LINK_TURNED_OFF)).not.toHaveLength(0);
    expect(screen.getByText(LINK_TURNED_OFF_BODY)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link settings" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Summary" })).toBeNull();
  });

  it("offers Try again when the numbers do not load", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "share_get_insights"
        ? Promise.reject({ kind: "NotFound", message: "This link isn't active any more." })
        : cmd === "share_list_comments"
          ? Promise.resolve({ comments: [], unreadable: null })
          : cmd === "share_get_reactions"
            ? Promise.resolve({ counts: [], total: 0 })
            : Promise.reject(new Error(`unexpected ${cmd}`)),
    );
    renderSheet();
    expect(await screen.findByText(/This link isn't active any more\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("the Insights side panel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    viewport.wide = true;
    answer({
      share_get_insights: PAID,
      share_list_comments: COMMENTS,
      share_get_reactions: NO_REACTIONS,
      share_get_link_settings: { offered: ALL_ON, on: ALL_ON, switchesInPlan: true },
    });
  });

  /** A page with an opener button, as a Captures row or Shared Links has. */
  function renderWithOpener() {
    const store = createStore();
    store.set(serverCapabilitiesAtom, CAPS);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Opener() {
      return (
        <button type="button" onClick={() => store.set(insightsSheetAtom, { shareToken: "tok", fileName: NAME })}>
          Open insights
        </button>
      );
    }
    render(
      <QueryClientProvider client={client}>
        <Provider store={store}>
          <Opener />
          <ShareInsightsSheet />
        </Provider>
      </QueryClientProvider>,
    );
    const opener = screen.getByRole("button", { name: "Open insights" });
    opener.focus();
    fireEvent.click(opener);
    return { store, opener };
  }

  it("opens beside the page as a labelled side panel, not a dialog, on a wide window", async () => {
    renderSheet();
    expect(await screen.findByRole("complementary", { name: `Insights for ${NAME}` })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The header: the name (whole, as a tooltip, for a long one) and Close.
    expect(screen.getByRole("heading", { level: 2, name: `Insights for ${NAME}` })).toHaveAttribute("title", NAME);
  });

  it("is a sheet over the page on a narrow window", async () => {
    viewport.wide = false;
    renderSheet();
    const sheet = await screen.findByRole("dialog", { name: `Insights for ${NAME}` });
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeInTheDocument();
    // Focus starts on the panel's heading, as in the inline panel.
    await waitFor(() => expect(within(sheet).getByRole("heading", { level: 2 })).toHaveFocus());
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes Link settings, not the sheet, on Escape on a narrow window", async () => {
    viewport.wide = false;
    const store = renderSheet();
    const sheet = await screen.findByRole("dialog", { name: `Insights for ${NAME}` });
    fireEvent.click(within(sheet).getByRole("button", { name: "Link settings" }));
    const settings = await within(sheet).findByRole("dialog", { name: "Link settings" });
    await waitFor(() => expect(within(settings).getByRole("heading", { name: "Link settings" })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link settings" })).toBeNull());
    expect(store.get(insightsSheetAtom)).not.toBeNull();
    expect(screen.getByRole("dialog", { name: `Insights for ${NAME}` })).toBeInTheDocument();
  });

  it("moves focus into the panel, closes on Escape and gives focus back to the opener", async () => {
    const { store, opener } = renderWithOpener();
    const heading = await screen.findByRole("heading", { level: 2, name: `Insights for ${NAME}` });
    await waitFor(() => expect(heading).toHaveFocus());

    fireEvent.keyDown(heading, { key: "Escape" });
    expect(store.get(insightsSheetAtom)).toBeNull();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("closes from its Close button and gives focus back to the opener", async () => {
    const { store, opener } = renderWithOpener();
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(store.get(insightsSheetAtom)).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("leaves Escape to a comment's menu while it is open", async () => {
    const { store } = renderWithOpener();
    await screen.findByText("Looks great at 1:23!");
    await openMenu("Ahmad");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(store.get(insightsSheetAtom)).not.toBeNull();
  });

  it("lets Escape put back a Delete or Block question without closing the panel", async () => {
    const { store } = renderWithOpener();
    await screen.findByText("Looks great at 1:23!");
    for (const [item, question] of [
      [/Delete comment/, "Delete this comment for everyone?"],
      [/^Block/, /^Block them on this link\?/],
    ] as const) {
      await openMenu("Ahmad");
      fireEvent.click(screen.getByRole("menuitem", { name: item }));
      const asking = screen.getByText(question);
      fireEvent.keyDown(document.activeElement ?? asking, { key: "Escape" });
      await waitFor(() => expect(screen.queryByText(question)).toBeNull());
      expect(store.get(insightsSheetAtom)).not.toBeNull();
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Comment actions for Ahmad" })[0]).toHaveFocus());
    }
    // With no question open, Escape closes the panel as before.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(store.get(insightsSheetAtom)).toBeNull();
  });

  it("ignores Escape pressed somewhere else on the page", async () => {
    const { store, opener } = renderWithOpener();
    await screen.findByRole("complementary");
    // The user clicks back on the page.
    fireEvent.pointerDown(opener);
    opener.focus();
    fireEvent.keyDown(opener, { key: "Escape" });
    expect(store.get(insightsSheetAtom)).not.toBeNull();
  });

  it("takes the place of File Details or Manage access rather than opening beside them", () => {
    const store = createStore();
    const file = { name: "Recording.mp4" } as FormattedUserFile;
    store.set(fileDetailsPanelAtom, file);
    store.set(insightsSheetAtom, { shareToken: "tok", fileName: NAME });
    expect(store.get(fileDetailsPanelAtom)).toBeNull();

    store.set(shareDriveModalAtom, { label: "Captures", folderName: "Captures" });
    expect(store.get(insightsSheetAtom)).toBeNull();

    store.set(insightsSheetAtom, { shareToken: "tok", fileName: NAME });
    expect(store.get(shareDriveModalAtom)).toBeNull();
    store.set(fileDetailsPanelAtom, file);
    expect(store.get(insightsSheetAtom)).toBeNull();
    // Closing one opens nothing else.
    store.set(fileDetailsPanelAtom, null);
    expect(store.get(insightsSheetAtom)).toBeNull();
  });
});

describe("the Insights Pages tab", () => {
  const DOC = "Pitch deck.pdf";
  const DOC_CAPS: ServerCapabilities = { ...CAPS, share_document_views: true };
  const PAID_DOC: ShareInsights = {
    plan: "paid",
    totalViews: 4,
    uniqueViewers: 2,
    completion: { state: "shown", value: 0.5 },
    retention: { state: "shown", value: null },
    viewers: {
      state: "shown",
      value: [
        { viewerId: "a", name: "Maya", visits: 1, watchedMs: 8_100, completion: 0.5, lastViewedAt: null, comments: 0, reactions: 0, pagesSeen: 2, pageCount: 4 },
      ],
    },
    pages: { state: "shown", value: { pageCount: 4, reach: [100, 75, 30, 25], medianMs: [4_200, 3_000, 900, 0] } },
  };

  beforeEach(() => {
    invokeMock.mockReset();
    push.mockReset();
    viewport.wide = true;
  });

  it("shows drop-off and time per page, and where most people stopped", async () => {
    answer({ share_get_insights: PAID_DOC, share_list_comments: NO_COMMENTS });
    renderSheet(DOC_CAPS, undefined, DOC);

    const panel = await showTab("Pages");
    expect(within(panel).getByText("Drop-off by page")).toBeInTheDocument();
    expect(within(panel).getByText("Most left after page 2")).toBeInTheDocument();
    const rows = within(within(panel).getByRole("list", { name: "Pages" })).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent(/Page 1.*reached by 100%.*median time 0:04/);
    expect(rows[2]).toHaveTextContent(/Page 3.*30%.*0:01/);
    expect(screen.queryByTestId("insights-locked")).toBeNull();
  });

  it("says how many pages each viewer saw", async () => {
    answer({ share_get_insights: PAID_DOC, share_list_comments: NO_COMMENTS });
    renderSheet(DOC_CAPS, undefined, DOC);
    const viewers = await showTab("Viewers");
    expect(within(viewers).getByText("2 of 4 pages")).toBeInTheDocument();
  });

  it("names a viewer by the email they confirmed, with the verified mark", async () => {
    const viewers: ShareInsights["viewers"] = {
      state: "shown",
      value: [
        { viewerId: "a", name: null, email: "alice@acme.com", visits: 1, watchedMs: 0, completion: null, lastViewedAt: null, comments: 0, reactions: 0 },
        { viewerId: "b", name: "Bob", email: "bob@acme.com", visits: 1, watchedMs: 0, completion: null, lastViewedAt: null, comments: 0, reactions: 0 },
        { viewerId: "c", name: null, visits: 1, watchedMs: 0, completion: null, lastViewedAt: null, comments: 0, reactions: 0 },
      ],
    };
    answer({ share_get_insights: { ...PAID_DOC, viewers }, share_list_comments: NO_COMMENTS });
    renderSheet(DOC_CAPS, undefined, DOC);
    const panel = await showTab("Viewers");
    const rows = within(within(panel).getByRole("list", { name: "Viewers" })).getAllByRole("listitem");
    // No name chosen: the email is the name.
    expect(rows[0]).toHaveTextContent("alice@acme.com");
    expect(within(rows[0]).getByText(VERIFIED_EMAIL)).toBeInTheDocument();
    // A chosen name stays first, the email under it.
    expect(rows[1]).toHaveTextContent(/Bob.*bob@acme\.com/);
    expect(within(rows[1]).getByText(VERIFIED_EMAIL)).toBeInTheDocument();
    // No email Rust could verify: no mark.
    expect(rows[2]).toHaveTextContent("Anonymous viewer");
    expect(within(rows[2]).queryByText(VERIFIED_EMAIL)).toBeNull();
  });

  it("says no page views yet on a document link nobody has read", async () => {
    answer({ share_get_insights: { ...PAID_DOC, pages: { state: "shown", value: null } }, share_list_comments: NO_COMMENTS });
    renderSheet(DOC_CAPS, undefined, DOC);
    const panel = await showTab("Pages");
    expect(within(panel).getByText("No page views yet")).toBeInTheDocument();
  });

  it("locks the Pages tab on the free plan, over sample pages only", async () => {
    answer({ share_get_insights: { ...FREE, pages: { state: "locked" } }, share_list_comments: NO_COMMENTS });
    renderSheet(DOC_CAPS, undefined, DOC);
    const panel = await showTab("Pages");
    const locked = within(panel).getByTestId("insights-locked");
    expect(within(locked).getByText(PAGES_LOCK_TITLE)).toBeInTheDocument();
    expect(within(locked).getByText(PAGES_LOCK_BODY)).toBeInTheDocument();
    const blurred = locked.firstElementChild as HTMLElement;
    expect(blurred).toHaveAttribute("aria-hidden", "true");
    expect(within(blurred).getAllByText(/^Page \d+$/)).toHaveLength(SAMPLE_PAGES.pageCount);
  });

  it("has no Pages tab while the server has document views but reports no pages", async () => {
    // Rust sends no `pages` from the capability alone.
    const { pages: _pages, ...noPages } = PAID_DOC;
    void _pages;
    answer({ share_get_insights: { ...noPages, pages: null }, share_list_comments: NO_COMMENTS });
    renderSheet(DOC_CAPS, undefined, DOC);
    await screen.findByRole("tab", { name: (n) => n.startsWith("Viewers") });
    expect(screen.queryByRole("tab", { name: "Pages" })).toBeNull();
    expect(screen.queryByText(PAGES_LOCK_TITLE)).toBeNull();
  });

  it("has no Pages tab on the free plan unless the server locks pages", async () => {
    answer({ share_get_insights: { ...FREE, pages: null }, share_list_comments: NO_COMMENTS });
    renderSheet(DOC_CAPS, undefined, DOC);
    await screen.findByTestId("insights-locked");
    expect(screen.queryByRole("tab", { name: "Pages" })).toBeNull();
  });

  it("has no Pages tab until the server has document views", async () => {
    // Rust sends no `pages` without `share_document_views`.
    const { pages: _pages, ...today } = PAID_DOC;
    void _pages;
    answer({ share_get_insights: today, share_list_comments: NO_COMMENTS });
    renderSheet(CAPS, undefined, DOC);
    await screen.findByRole("tab", { name: (n) => n.startsWith("Viewers") });
    expect(screen.queryByRole("tab", { name: "Pages" })).toBeNull();
  });

  it("has no Pages tab on a recording's link, even on the free plan", async () => {
    answer({ share_get_insights: { ...FREE, pages: { state: "locked" } }, share_list_comments: NO_COMMENTS });
    renderSheet(DOC_CAPS);
    await screen.findByRole("tab", { name: (n) => n.startsWith("Viewers") });
    expect(screen.queryByRole("tab", { name: "Pages" })).toBeNull();
  });
});

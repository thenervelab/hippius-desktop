import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MotionGlobalConfig } from "framer-motion";

import ShareInsightsSheet from "../ShareInsightsSheet";
import {
  LOCKED_ACTION,
  LOCKED_PROMPT,
  LOCK_BODY,
  LOCK_BODY_NOT_COUNTING,
  LOCK_TITLE,
  PRICING_URL,
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

function answer(map: Record<string, unknown>) {
  invokeMock.mockImplementation((cmd: string) =>
    cmd in map ? Promise.resolve(map[cmd]) : Promise.reject(new Error(`unexpected ${cmd}`)),
  );
}

function renderSheet(caps: ServerCapabilities = CAPS, seed?: (client: QueryClient) => void) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, caps);
  store.set(insightsSheetAtom, { shareToken: "tok", fileName: NAME });
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

    const locked = await screen.findByTestId("insights-locked");
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("unique viewer")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("share_get_insights", { shareToken: "tok" });

    const blurred = locked.firstElementChild as HTMLElement;
    expect(blurred).toHaveAttribute("aria-hidden", "true");
    expect(blurred).toHaveAttribute("inert");
    expect(blurred.className).toContain("blur");
    // What is drawn there is the made-up sample, never anything of the link's.
    expect(within(blurred).getByText(SAMPLE_VIEWERS[0].name!)).toBeInTheDocument();
    expect(within(blurred).getByText("68%")).toBeInTheDocument();

    expect(within(locked).getByText(LOCK_TITLE)).toBeInTheDocument();
    expect(within(locked).getByText(LOCK_BODY)).toBeInTheDocument();
    fireEvent.click(within(locked).getByRole("button", { name: "Compare plans" }));
    expect(openUrl).toHaveBeenCalledWith(PRICING_URL);
    fireEvent.click(within(locked).getByRole("button", { name: "Upgrade plan" }));
    expect(push).toHaveBeenCalledWith("/settings?section=billing");
    expect(store.get(insightsSheetAtom)).toBeNull();
  });

  it("says comments are all included on the free plan", async () => {
    answer({ share_get_insights: FREE, share_list_comments: COMMENTS });
    renderSheet();
    expect(await screen.findByText("2 · all included on your plan")).toBeInTheDocument();
  });

  it("shows a paid plan everything, with Anonymous viewer for a viewer who chose no name", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS });
    renderSheet();

    expect(await screen.findByText("25%")).toBeInTheDocument();
    expect(screen.queryByTestId("insights-locked")).toBeNull();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("3 people watched")).toBeInTheDocument();
    // Average watch: everything watched over every view, (78 + 12) s / 5.
    expect(screen.getByText("0:18")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Where people stopped" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Where people stopped\. 60% reached the end\./ })).toBeInTheDocument();
    expect(screen.getAllByText("Ahmad").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Anonymous viewer").length).toBeGreaterThan(0);
    expect(screen.getByText("2 visits")).toBeInTheDocument();
    expect(screen.getByTitle("Watched 1:18")).toBeInTheDocument();
    // Few viewers and comments: one scroll, no tabs.
    expect(screen.queryByRole("tablist")).toBeNull();
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

  it("splits into tabs once there are more than ten viewers", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      viewerId: `v${i}`,
      name: `Viewer ${i}`,
      visits: 1,
      watchedMs: 10_000,
      completion: 0.5,
      lastViewedAt: null,
      comments: 0,
      reactions: 0,
    }));
    answer({
      share_get_insights: { ...PAID, viewers: { state: "shown", value: many } },
      share_list_comments: COMMENTS,
    });
    renderSheet();

    const tabs = await screen.findByRole("tablist", { name: "Insights" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Overview",
      "Viewers 11",
      "Comments 2",
    ]);
    // The overview lists five, and "See all" opens the Viewers tab.
    fireEvent.click(screen.getByRole("button", { name: "See all 11 viewers" }));
    expect(within(tabs).getByRole("tab", { name: "Viewers 11" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("Viewer 10").length).toBeGreaterThan(0);
  });

  // A name keeps its LRM/RLM/ALM marks, which would otherwise reorder the
  // text after it in the same line (" · 2m ago"), so each name is isolated.
  it("isolates viewer and commenter names from the text around them", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS });
    renderSheet();

    expect(await screen.findByText("Looks great at 1:23!")).toBeInTheDocument();
    const names = screen.getAllByText("Ahmad");
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const name of names) expect(name.tagName).toBe("BDI");
    for (const anon of screen.getAllByText("Anonymous viewer")) expect(anon.tagName).toBe("BDI");
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
    // The server lists no block state, so the row says it.
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

  it("shows the reaction totals, and that viewers don't see them while Reactions is off", async () => {
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

    const totals = await screen.findByRole("list", { name: "Reaction totals" });
    // Most first, as bars.
    expect(within(totals).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "👍3 reactions",
      "🔥1 reaction",
    ]);
    expect(await screen.findByText(/Reactions are off, so viewers don't see these/)).toBeInTheDocument();
  });

  it("changes a link switch at once and puts it back when the server refuses", async () => {
    let settingsCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "share_get_insights") return Promise.resolve(PAID);
      if (cmd === "share_list_comments") return Promise.resolve({ comments: [], unreadable: null });
      if (cmd === "share_get_reactions") return Promise.resolve({ counts: [], total: 0 });
      if (cmd === "share_get_link_settings")
        return Promise.resolve({
          offered: { insights: true, comments: true, reactions: true },
          on: { insights: true, comments: false, reactions: true },
        });
      if (cmd === "share_set_link_settings") {
        settingsCalls += 1;
        return settingsCalls === 1 ? Promise.resolve() : Promise.reject({ kind: "Api", message: "nope" });
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    renderSheet();

    const comments = await screen.findByRole("switch", { name: "Comments" });
    expect(comments).toHaveAttribute("aria-checked", "false");
    fireEvent.click(comments);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", {
        shareToken: "tok",
        settings: { insights: true, comments: true, reactions: true },
      }),
    );
    expect(screen.getByRole("switch", { name: "Comments" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("switch", { name: "Insights" }));
    await waitFor(() => expect(settingsCalls).toBe(2));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Insights" })).toHaveAttribute("aria-checked", "true"));
  });

  describe("on the free plan", () => {
    const ALL = { insights: true, comments: true, reactions: true };
    function freeLink(on: { insights: boolean; comments: boolean; reactions: boolean }) {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "share_get_insights") return Promise.resolve({ ...FREE, totalViews: 0, uniqueViewers: 0 });
        if (cmd === "share_list_comments") return Promise.resolve({ comments: [], unreadable: null });
        if (cmd === "share_get_reactions") return Promise.resolve({ counts: [], total: 0 });
        if (cmd === "share_get_link_settings") return Promise.resolve({ offered: ALL, on, switchesInPlan: false });
        if (cmd === "share_set_link_settings") return Promise.resolve();
        return Promise.reject(new Error(`unexpected ${cmd}`));
      });
    }

    it("draws a link that is not counting views from samples only, under the lock", async () => {
      freeLink({ insights: false, comments: true, reactions: true });
      renderSheet();

      const locked = await screen.findByTestId("insights-locked");
      const blurred = locked.firstElementChild as HTMLElement;
      await waitFor(() => expect(within(blurred).getByText(String(SAMPLE_VIEWS))).toBeInTheDocument());
      expect(within(blurred).getByText(`${SAMPLE_UNIQUE_VIEWERS} people watched`)).toBeInTheDocument();
      // No "0 views" outside the lock: nothing is being counted.
      expect(screen.queryByText("0")).toBeNull();
      expect(within(locked).getByText(LOCK_BODY_NOT_COUNTING)).toBeInTheDocument();
    });

    it("shows the upgrade prompt when a switch is turned on, and sends nothing", async () => {
      freeLink({ insights: false, comments: false, reactions: false });
      const store = renderSheet();

      const insights = await screen.findByRole("switch", { name: "Insights" });
      expect(screen.getByText("Count views and watch time. On paid Drive plans.")).toBeInTheDocument();
      expect(screen.getByText("Let viewers comment on this link. On paid Drive plans.")).toBeInTheDocument();
      expect(screen.getByText("Let viewers react with emoji. On paid Drive plans.")).toBeInTheDocument();
      fireEvent.click(insights);
      expect(insights).toHaveAttribute("aria-checked", "false");
      const prompt = screen.getByRole("region", { name: "Upgrade for Insights, comments and reactions" });
      expect(within(prompt).getByText(LOCKED_PROMPT)).toBeInTheDocument();
      expect(LOCKED_PROMPT).toBe("Insights, comments and reactions are available on paid Drive plans");

      for (const name of ["Comments", "Reactions"]) {
        fireEvent.click(screen.getByRole("switch", { name }));
        expect(screen.getByRole("switch", { name })).toHaveAttribute("aria-checked", "false");
      }
      expect(invokeMock).not.toHaveBeenCalledWith("share_set_link_settings", expect.anything());

      fireEvent.click(within(prompt).getByRole("button", { name: LOCKED_ACTION }));
      expect(push).toHaveBeenCalledWith("/settings?section=billing");
      expect(store.get(insightsSheetAtom)).toBeNull();
    });

    it("lets a link that already has comments and reactions on turn them off, but not back on", async () => {
      freeLink({ insights: false, comments: true, reactions: true });
      renderSheet();

      const comments = await screen.findByRole("switch", { name: "Comments" });
      expect(comments).toHaveAttribute("aria-checked", "true");
      fireEvent.click(comments);
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", {
          shareToken: "tok",
          settings: { insights: false, comments: false, reactions: true },
        }),
      );
      fireEvent.click(screen.getByRole("switch", { name: "Reactions" }));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", {
          shareToken: "tok",
          settings: { insights: false, comments: false, reactions: false },
        }),
      );
      await waitFor(() => expect(screen.getByRole("switch", { name: "Comments" })).toHaveAttribute("aria-checked", "false"));
      expect(screen.queryByText(LOCKED_PROMPT)).toBeNull();
    });

    it("leaves a link that already has Insights on as it is, and lets it turn them off", async () => {
      freeLink(ALL);
      renderSheet();

      const insights = await screen.findByRole("switch", { name: "Insights" });
      expect(insights).toHaveAttribute("aria-checked", "true");
      // Its real counts are shown, not samples.
      expect(await screen.findAllByText("0")).toHaveLength(2);
      fireEvent.click(insights);
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("share_set_link_settings", {
          shareToken: "tok",
          settings: { insights: false, comments: true, reactions: true },
        }),
      );
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

    await screen.findByText("25%");
    expect(screen.queryByText("Comments")).toBeNull();
    expect(screen.queryByText("Reactions")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("share_list_comments", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("share_get_reactions", expect.anything());
  });

  it("explains each number on request", async () => {
    answer({ share_get_insights: PAID, share_list_comments: { comments: [], unreadable: null } });
    renderSheet();
    await screen.findByText("25%");
    expect(screen.getByText("How we count views")).toBeInTheDocument();
    expect(screen.getByText("Each time the link is opened.")).toBeInTheDocument();
  });

  describe("a link nothing has happened on yet", () => {
    const EMPTY = { ...PAID, totalViews: 0, uniqueViewers: 0, viewers: { state: "shown" as const, value: [] } };

    it("is one short block with the link's switches right under it, not an empty state per section", async () => {
      answer({
        share_get_insights: EMPTY,
        share_list_comments: NO_COMMENTS,
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: { offered: ALL_ON, on: ALL_ON, switchesInPlan: true },
      });
      renderSheet();

      expect(await screen.findByText("No views yet")).toBeInTheDocument();
      expect(
        screen.getByText("Nobody has opened this link yet. Views, comments and reactions show up here once they do."),
      ).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "On this link" })).toBeInTheDocument();
      // No zero, no tiles, no per-section empty states, no footer.
      expect(screen.queryByText("views")).toBeNull();
      expect(screen.queryByText("None yet")).toBeNull();
      expect(screen.queryByText("No comments yet.")).toBeNull();
      expect(screen.queryByText("No reactions yet.")).toBeNull();
      expect(screen.queryByRole("contentinfo")).toBeNull();
    });

    it("says the link is not counting views when its Insights switch is off", async () => {
      answer({
        share_get_insights: EMPTY,
        share_list_comments: NO_COMMENTS,
        share_get_reactions: NO_REACTIONS,
        share_get_link_settings: { offered: ALL_ON, on: { ...ALL_ON, insights: false }, switchesInPlan: true },
      });
      renderSheet();
      expect(await screen.findByText("Not counting views")).toBeInTheDocument();
    });

    it("waits for comments and reactions before deciding, so the block never flashes", async () => {
      invokeMock.mockImplementation((cmd: string) =>
        cmd === "share_get_insights" ? Promise.resolve(EMPTY) : new Promise(() => {}),
      );
      renderSheet();
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_get_insights", { shareToken: "tok" }));
      expect(screen.getByTestId("insights-loading")).toBeInTheDocument();
      expect(screen.queryByText("No views yet")).toBeNull();
    });

    it("keeps one line for no views once there are comments", async () => {
      answer({
        share_get_insights: EMPTY,
        share_list_comments: COMMENTS,
        share_get_reactions: NO_REACTIONS,
      });
      renderSheet();
      expect(await screen.findByText("Looks great at 1:23!")).toBeInTheDocument();
      expect(screen.getByText("No views yet")).toBeInTheDocument();
      expect(screen.getByText("Views show up here once someone opens the link.")).toBeInTheDocument();
      expect(screen.queryByText("None yet")).toBeNull();
      expect(screen.getByText("No reactions yet.")).toBeInTheDocument();
    });
  });

  it("keeps On this link one click away in the footer, from any tab", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      viewerId: `v${i}`,
      name: `Viewer ${i}`,
      visits: 1,
      watchedMs: 10_000,
      completion: 0.5,
      lastViewedAt: null,
      comments: 0,
      reactions: 0,
    }));
    answer({
      share_get_insights: { ...PAID, viewers: { state: "shown", value: many } },
      share_list_comments: NO_COMMENTS,
      share_get_reactions: NO_REACTIONS,
      share_get_link_settings: { offered: ALL_ON, on: { ...ALL_ON, comments: false }, switchesInPlan: true },
    });
    renderSheet();

    const footer = await screen.findByRole("contentinfo");
    expect(footer).toHaveTextContent("On this linkInsights and reactions on, comments off");
    fireEvent.click(await screen.findByRole("tab", { name: "Viewers 11" }));
    expect(screen.getByRole("tab", { name: "Viewers 11" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(footer).getByRole("button", { name: /^On this link/ }));
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByRole("heading", { name: "On this link" })).toHaveFocus());
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

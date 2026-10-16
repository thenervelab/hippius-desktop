import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ShareInsightsSheet from "../ShareInsightsSheet";
import { LOCKED_PROMPT, SAMPLE_VIEWERS } from "../insightsView";
import { insightsSheetAtom, serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";
import type { ShareComments, ShareInsights } from "@/app/lib/tauri/shareInsights";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

function answer(map: Record<string, unknown>) {
  invokeMock.mockImplementation((cmd: string) =>
    cmd in map ? Promise.resolve(map[cmd]) : Promise.reject(new Error(`unexpected ${cmd}`)),
  );
}

function renderSheet(caps: ServerCapabilities = CAPS) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, caps);
  store.set(insightsSheetAtom, { shareToken: "tok", fileName: "Recording 2026-10-13.mp4" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <ShareInsightsSheet />
      </Provider>
    </QueryClientProvider>,
  );
  return store;
}

describe("ShareInsightsSheet", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    push.mockReset();
  });

  it("gives a free plan its two numbers and only sample data, blurred, behind the upgrade", async () => {
    answer({ share_get_insights: FREE, share_list_comments: { comments: [], unreadable: null } });
    const store = renderSheet();

    const locked = await screen.findByTestId("insights-locked");
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("share_get_insights", { shareToken: "tok" });

    const blurred = locked.firstElementChild as HTMLElement;
    expect(blurred).toHaveAttribute("aria-hidden", "true");
    expect(blurred).toHaveAttribute("inert");
    expect(blurred.className).toContain("blur");
    // What is drawn there is the made-up sample, never anything of the link's.
    expect(within(blurred).getByText(SAMPLE_VIEWERS[0].name!)).toBeInTheDocument();
    expect(within(blurred).getByText("68%")).toBeInTheDocument();

    expect(screen.getByText(LOCKED_PROMPT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "See plans" }));
    expect(push).toHaveBeenCalledWith("/settings?section=billing");
    expect(store.get(insightsSheetAtom)).toBeNull();
  });

  it("shows a paid plan everything, with Someone for a viewer who chose no name", async () => {
    answer({ share_get_insights: PAID, share_list_comments: { comments: [], unreadable: null } });
    renderSheet();

    expect(await screen.findByText("25%")).toBeInTheDocument();
    expect(screen.queryByTestId("insights-locked")).toBeNull();
    expect(screen.getByRole("img", { name: "Retention: 60% of visits reached the end" })).toBeInTheDocument();
    expect(screen.getByText("Ahmad")).toBeInTheDocument();
    expect(screen.getByText("Someone")).toBeInTheDocument();
    expect(screen.getByText("Watched 1:18 (50%) · 2 visits · 1 comment")).toBeInTheDocument();
  });

  // A name keeps its LRM/RLM/ALM marks, which would otherwise reorder the
  // text after it in the same line (" · 2m ago"), so each name is isolated.
  it("isolates viewer and commenter names from the text around them", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS });
    renderSheet();

    expect(await screen.findByText("Looks great at 1:23!")).toBeInTheDocument();
    const names = screen.getAllByText("Ahmad");
    expect(names).toHaveLength(2);
    for (const name of names) expect(name.tagName).toBe("BDI");
    for (const someone of screen.getAllByText("Someone")) expect(someone.tagName).toBe("BDI");
  });

  it("lists comments and deletes one only after asking in its row", async () => {
    answer({ share_get_insights: PAID, share_list_comments: COMMENTS, share_delete_comment: undefined });
    renderSheet();

    expect(await screen.findByText("Looks great at 1:23!")).toBeInTheDocument();
    // The moment it is about, beside who wrote it.
    expect(
      screen.getByText((_, el) => el?.tagName === "P" && /^Ahmad · .+ · at 1:23$/.test(el.textContent ?? "")),
    ).toBeInTheDocument();
    const deletes = screen.getAllByRole("button", { name: "Delete comment" });
    fireEvent.click(deletes[1]);
    expect(screen.getByText("Delete this comment for everyone?")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("share_delete_comment", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_delete_comment", { shareToken: "tok", commentId: "c2" }),
    );
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
    expect(invokeMock).not.toHaveBeenCalledWith("share_list_comments", expect.anything());
  });

  it("explains each number on request", async () => {
    answer({ share_get_insights: PAID, share_list_comments: { comments: [], unreadable: null } });
    renderSheet();
    await screen.findByText("25%");
    expect(screen.getByText("See how we calculate this")).toBeInTheDocument();
    expect(screen.getByText("Each time the link is opened.")).toBeInTheDocument();
  });

  it("offers Try again when the numbers do not load", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "share_get_insights"
        ? Promise.reject({ kind: "NotFound", message: "This link isn't active any more." })
        : Promise.resolve({ comments: [], unreadable: null }),
    );
    renderSheet();
    expect(await screen.findByText(/This link isn't active any more\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

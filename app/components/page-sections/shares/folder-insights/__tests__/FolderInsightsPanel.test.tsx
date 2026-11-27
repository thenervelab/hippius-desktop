// The folder link Insights panel draws Rust's answer: the files opened (a
// document opens to its pages and viewers), the people who opened them, the
// sample under the upgrade prompt on a free plan, the switch with Rust's
// plan answer, and Export CSV through Rust.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionGlobalConfig } from "framer-motion";

import FolderInsightsPanel, { folderSubtitle, SWITCH_NEEDS_PLAN } from "../FolderInsightsPanel";
import { FOLDER_LOCK_TITLE } from "../FolderInsightsBody";
import { folderInsightsAtom, type FolderInsightsTarget } from "../folderInsightsTarget";
import { insightsSheetAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { SAMPLE_LABEL } from "@/components/page-sections/shares/insights/insightsView";
import type { FolderInsights } from "@/app/lib/tauri/folderInsights";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...a: unknown[]) => saveMock(...a) }));
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: async () => "/Users/me/Downloads",
  join: async (...p: string[]) => p.join("/"),
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("@/app/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks")>();
  return {
    ...actual,
    useBreakpoint: () => ({ breakpoint: "xl", isMobile: false, isTablet: false, isLaptop: false, isDesktop: true, isLargeDesktop: false }),
  };
});
MotionGlobalConfig.skipAnimations = true;

const HASH = "a".repeat(64);
const TARGET: FolderInsightsTarget = {
  tokenHash: HASH,
  name: "Board room",
  createdAt: "2026-11-03T10:00:00Z",
  expiresAt: null,
  revoked: false,
  insightsOn: true,
};

const PAID: FolderInsights = {
  plan: "paid",
  totalViews: 5,
  uniqueViewers: 2,
  files: [
    {
      path: "q3/report.pdf",
      name: "report.pdf",
      folder: "q3",
      totalViews: 3,
      uniqueViewers: 2,
      read: 0.75,
      timeMs: 92_000,
      pages: { pageCount: 3, reach: [100, 80, 40], medianMs: [4000, 3000, 1000] },
      viewers: {
        state: "shown",
        value: [
          {
            viewerId: "q1w2e3",
            label: "Viewer q1w2",
            visits: 2,
            lastViewedAt: "2026-11-06T10:00:00Z",
            completion: null,
            pagesSeen: 2,
            pageCount: 3,
            pageTimeMs: 82_000,
          },
        ],
      },
    },
    {
      path: "clip.mp4",
      name: "clip.mp4",
      folder: "",
      totalViews: 2,
      uniqueViewers: 1,
      read: null,
      timeMs: null,
      pages: null,
      viewers: { state: "shown", value: [] },
    },
  ],
  people: {
    state: "shown",
    value: [
      {
        viewerId: "q1w2e3",
        label: "Viewer q1w2",
        visits: 4,
        lastViewedAt: "2026-11-08T10:00:00Z",
        pageTimeMs: 82_000,
        files: [
          { path: "clip.mp4", name: "clip.mp4", visits: 2, lastViewedAt: "2026-11-08T10:00:00Z", pagesSeen: null, pageCount: null, pageTimeMs: null },
          { path: "q3/report.pdf", name: "report.pdf", visits: 2, lastViewedAt: "2026-11-06T10:00:00Z", pagesSeen: 2, pageCount: 3, pageTimeMs: 82_000 },
        ],
      },
    ],
  },
};

const FREE: FolderInsights = {
  plan: "free",
  totalViews: 4,
  uniqueViewers: 2,
  files: [
    { path: "a.pdf", name: "a.pdf", folder: "", totalViews: 4, uniqueViewers: 2, read: null, timeMs: null, pages: null, viewers: { state: "locked" } },
  ],
  people: { state: "locked" },
};

function answer(insights: FolderInsights, extra: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (extra[cmd]) return extra[cmd](args);
    if (cmd === "folder_share_get_insights") return insights;
    if (cmd === "folder_share_insights_csv_name") return "Board room activity 2026-11-18.csv";
    // A server without folder gates or NDAs, unless a test says otherwise.
    if (cmd === "share_get_gate") return { offered: false, on: false, allowCount: 0, blockCount: 0, lists: null, inPlan: null };
    if (cmd === "share_get_nda") return { offered: false, on: false, text: null, editable: false, inPlan: null };
    if (cmd === "share_nda_accepts") return { offered: false, hasText: false, text: null, accepts: [], nextAfter: null };
    return undefined;
  });
}

/** Opens Link settings from the header's gear and returns the view. */
async function openSettings() {
  fireEvent.click(await screen.findByRole("button", { name: "Link settings" }));
  return screen.findByRole("region", { name: "Link settings" });
}

function renderPanel(target: FolderInsightsTarget = TARGET) {
  const store = createStore();
  store.set(folderInsightsAtom, target);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <Provider store={store}>
      <QueryClientProvider client={client}>
        <FolderInsightsPanel />
      </QueryClientProvider>
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  invokeMock.mockReset();
  saveMock.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  push.mockReset();
});

describe("FolderInsightsPanel", () => {
  it("reads the link by its hash and lists the files opened, most viewed first", async () => {
    answer(PAID);
    renderPanel();
    const rows = await screen.findAllByTestId("folder-insights-file");
    expect(invokeMock).toHaveBeenCalledWith("folder_share_get_insights", { tokenHash: HASH });
    expect(rows.map((r) => r.getAttribute("data-path"))).toEqual(["q3/report.pdf", "clip.mp4"]);
    expect(within(rows[0]).getByTestId("folder-file-facts")).toHaveTextContent("q3 · 3 views · 2 people · 75% read");
    expect(within(rows[0]).getByTestId("folder-time")).toHaveTextContent("1:32");
    const summary = screen.getByTestId("folder-insights-summary");
    expect(summary).toHaveTextContent(/^Views5Viewers2Files2$/);
  });

  it("opens a document to its pages and who read it", async () => {
    answer(PAID);
    renderPanel();
    const [doc] = await screen.findAllByTestId("folder-insights-file");
    fireEvent.click(within(doc).getByRole("button"));
    const detail = within(doc).getByTestId("folder-file-detail");
    expect(within(detail).getByText("Page 3")).toBeInTheDocument();
    expect(within(detail).getByText("Viewer q1w2")).toBeInTheDocument();
    expect(detail).toHaveTextContent("2 visits");
  });

  it("shows the room: each person and the files they opened", async () => {
    answer(PAID);
    renderPanel();
    await screen.findAllByTestId("folder-insights-file");
    fireEvent.click(screen.getByRole("tab", { name: /People/ }));
    const person = screen.getByTestId("folder-insights-person");
    expect(person).toHaveTextContent("Viewer q1w2");
    expect(person).toHaveTextContent("Opened 2 files");
    fireEvent.click(within(person).getByRole("button"));
    const files = within(person).getByTestId("folder-person-files");
    expect(within(files).getAllByText(/clip\.mp4|report\.pdf/).map((e) => e.textContent)).toEqual(["clip.mp4", "report.pdf"]);
  });

  it("draws only a labelled sample under the upgrade prompt on a free plan, and offers no export", async () => {
    answer(FREE);
    renderPanel();
    const [file] = await screen.findAllByTestId("folder-insights-file");
    expect(within(file).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    const locked = screen.getByTestId("folder-insights-locked");
    expect(locked).toHaveTextContent(FOLDER_LOCK_TITLE);
    expect(locked).toHaveTextContent(SAMPLE_LABEL);
  });

  it("shows the prompt instead of zeros for a free link that counts nothing", async () => {
    answer({ ...FREE, totalViews: 0, files: [] });
    renderPanel({ ...TARGET, insightsOn: false });
    expect(await screen.findByTestId("folder-insights-locked")).toBeInTheDocument();
    expect(screen.queryByTestId("folder-insights-summary")).toBeNull();
  });

  it("turns Insights off and on through Rust, and shows Rust's plan answer", async () => {
    const calls: unknown[] = [];
    answer(PAID, {
      folder_share_set_insights: (args) => {
        calls.push(args);
        return args.on ? { outcome: "needsPaidPlan" } : { outcome: "saved", insights: false };
      },
    });
    renderPanel();
    await screen.findAllByTestId("folder-insights-file");
    // The switch is in Link settings, not under the header.
    expect(screen.queryByTestId("folder-insights-switch")).toBeNull();
    const settings = await openSettings();
    const toggle = within(within(settings).getByTestId("folder-insights-switch")).getByRole("switch", { name: "Insights" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByTestId("folder-insights-subtitle")).toHaveTextContent("Insights off");
    fireEvent.click(toggle);
    expect(await screen.findByText(SWITCH_NEEDS_PLAN)).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(calls).toEqual([
      { tokenHash: HASH, on: false },
      { tokenHash: HASH, on: true },
    ]);
  });

  it("exports the CSV through Rust where the save dialog points, and a cancel does nothing", async () => {
    answer(PAID);
    renderPanel();
    await screen.findAllByTestId("folder-insights-file");
    saveMock.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock.mock.calls[0][0]).toMatchObject({ defaultPath: "/Users/me/Downloads/Board room activity 2026-11-18.csv" });
    expect(invokeMock).not.toHaveBeenCalledWith("folder_share_export_insights_csv", expect.anything());

    saveMock.mockResolvedValueOnce("/Users/me/Desktop/out.csv");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("CSV saved"));
    expect(invokeMock).toHaveBeenCalledWith("folder_share_export_insights_csv", {
      tokenHash: HASH,
      folderName: "Board room",
      destination: "/Users/me/Desktop/out.csv",
    });
  });

  it("says what failed and offers Try again", async () => {
    invokeMock.mockRejectedValue({ kind: "NotFound", message: "This link isn't active any more." });
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load insights. This link isn't active any more.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shares the side panels' one slot", async () => {
    answer(PAID);
    const store = renderPanel();
    await screen.findAllByTestId("folder-insights-file");
    act(() => store.set(insightsSheetAtom, { shareToken: "t", fileName: "x.png" }));
    expect(store.get(folderInsightsAtom)).toBeNull();
  });

  it("asks for an email on the folder link by its hash, where Rust offers it", async () => {
    const off = { offered: true, on: false, allowCount: 0, blockCount: 0, lists: null, inPlan: true };
    answer(PAID, {
      share_get_gate: () => off,
      share_set_gate: () => ({ ...off, on: true, lists: { allow: [], block: [] } }),
    });
    renderPanel();
    await screen.findAllByTestId("folder-insights-file");
    const settings = await openSettings();
    const row = await within(settings).findByTestId("rule-gate");
    expect(invokeMock).toHaveBeenCalledWith("share_get_gate", { shareToken: HASH, kind: "folder" });
    expect(invokeMock).toHaveBeenCalledWith("share_get_nda", { shareToken: HASH, kind: "folder" });
    expect(within(settings).getByTestId("rule-allowList")).toBeInTheDocument();
    expect(within(settings).queryByTestId("rule-nda")).toBeNull();

    // A short rule: its switch is in its row.
    const ask = within(row).getByRole("switch", { name: "Ask for email" });
    fireEvent.click(ask);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_gate", { shareToken: HASH, allow: "", block: "", kind: "folder" }),
    );
    await waitFor(() => expect(ask).toHaveAttribute("aria-checked", "true"));

    // The Allow list opens a level further in, in place of the switch.
    fireEvent.click(within(within(settings).getByTestId("rule-allowList")).getByRole("button"));
    expect(await within(settings).findByRole("heading", { name: "Allow list" })).toBeInTheDocument();
    expect(within(settings).queryByTestId("folder-insights-switch")).toBeNull();
    fireEvent.click(within(settings).getByRole("button", { name: "Back to Link settings" }));
    expect(await within(settings).findByTestId("folder-insights-switch")).toBeInTheDocument();

    // Back to the numbers, which were there all along.
    fireEvent.click(within(settings).getByRole("button", { name: "Back to Insights" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Link settings" })).toBeNull());
    expect(screen.getByTestId("folder-insights-summary")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Link settings" })).toHaveFocus());
  });

  it("has no rules for a revoked link", async () => {
    answer(PAID, { share_get_gate: () => ({ offered: true, on: false, allowCount: 0, blockCount: 0, lists: null, inPlan: true }) });
    renderPanel({ ...TARGET, revoked: true });
    await screen.findAllByTestId("folder-insights-file");
    expect(screen.queryByRole("button", { name: "Link settings" })).toBeNull();
    expect(screen.queryByTestId("folder-link-rules")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("share_get_gate", expect.anything());
  });

  // While its folder is in Drive Trash the server keeps the link off; the
  // panel says so as Shared Links does, and only when the listing said so.
  it("marks a link paused by Trash, and says why", async () => {
    answer(PAID);
    renderPanel({ ...TARGET, paused: true, held: true });
    const badge = await screen.findByTestId("folder-link-paused");
    expect(badge).toHaveTextContent("Paused");
    expect(badge).toHaveAttribute("title", "Off until you revoke it: its folder left Trash another way");
  });

  it("shows no Paused badge on a link the server did not pause", async () => {
    answer(PAID);
    renderPanel();
    await screen.findAllByTestId("folder-insights-file");
    expect(screen.queryByTestId("folder-link-paused")).toBeNull();
  });

  it("shows no Paused badge on a revoked link", async () => {
    answer(PAID);
    renderPanel({ ...TARGET, revoked: true, paused: true });
    await screen.findAllByTestId("folder-insights-file");
    expect(screen.queryByTestId("folder-link-paused")).toBeNull();
  });

  it("lists who accepted the folder link's NDA, by typed name, else the People tab's label", async () => {
    answer(PAID, {
      share_get_nda: () => ({ offered: true, on: true, text: "Keep it quiet.", editable: true, inPlan: true }),
      share_nda_accepts: () => ({
        offered: true,
        hasText: true,
        text: "Keep it quiet.",
        accepts: [
          { id: 1, viewerId: "q1w2e3", email: null, signerName: null, acceptedAt: "2026-11-05T10:00:00Z", earlier: false },
          { id: 2, viewerId: "zz", email: null, signerName: "Dana Reyes", acceptedAt: "2026-11-06T10:00:00Z", earlier: false },
        ],
        nextAfter: null,
      }),
      share_nda_accepts_csv_name: () => "Board room NDA accepts 2026-11-18.csv",
    });
    renderPanel();
    const settings = await openSettings();
    expect(within(await within(settings).findByTestId("rule-nda")).getByText("On")).toBeInTheDocument();
    fireEvent.click(within(settings).getByRole("button", { name: "Back to Insights" }));
    fireEvent.click(await screen.findByRole("tab", { name: /NDA/ }));
    expect(invokeMock).toHaveBeenCalledWith("share_nda_accepts", { shareToken: HASH, after: 0, kind: "folder" });
    const rows = await screen.findAllByTestId("nda-accept");
    expect(rows[0]).toHaveTextContent("Dana Reyes");
    expect(rows[1]).toHaveTextContent("Viewer q1w2");
    expect(screen.getByTestId("nda-current-text")).toHaveTextContent("Keep it quiet.");

    saveMock.mockResolvedValueOnce("/Users/me/Desktop/accepts.csv");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_export_nda_accepts_csv", {
        shareToken: HASH,
        fileName: "Board room",
        destination: "/Users/me/Desktop/accepts.csv",
        viewerNames: { q1w2e3: "Viewer q1w2" },
        kind: "folder",
      }),
    );
  });

  it("words the header's line from the link", () => {
    const now = Date.parse("2026-11-18T00:00:00Z");
    expect(folderSubtitle(TARGET, true, now)).toBe("Shared Nov 3 · link on");
    expect(folderSubtitle(TARGET, false, now)).toBe("Shared Nov 3 · link on · Insights off");
    expect(folderSubtitle({ ...TARGET, revoked: true }, false, now)).toBe("Shared Nov 3 · link revoked");
  });
});

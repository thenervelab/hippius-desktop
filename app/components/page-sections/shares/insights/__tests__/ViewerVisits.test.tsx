import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ViewerVisits, visitLine, visitsSummary } from "../ViewerVisits";
import type { ViewerVisits as Page } from "@/app/lib/tauri/shareInsights";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const PAGE: Page = {
  viewerId: "AQEBAQEBAQEBAQEBAQEBAQ",
  visitsTotal: 3,
  timeSpentMs: 540_000,
  pageTimeMs: [42_000, 61_000, 0, 3_000],
  visits: [
    { startedAt: "2026-11-20T09:12:00Z", lastSeenAt: "2026-11-20T09:20:41Z", kind: "document", timeSpentMs: 106_000, pagesSeen: 3 },
    { startedAt: "2026-11-19T09:12:00Z", lastSeenAt: "2026-11-19T09:13:00Z", kind: "document", timeSpentMs: null, pagesSeen: 1 },
  ],
  nextBefore: "cursor-1",
};

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(
    <Wrapper>
      <ViewerVisits shareToken="tok" viewerId={PAGE.viewerId} />
    </Wrapper>,
  );
}

describe("one viewer's visits", () => {
  beforeEach(() => invokeMock.mockReset());

  it("words the totals and each visit", () => {
    expect(visitsSummary({ visitsTotal: 1, timeSpentMs: 0 })).toBe("1 visit");
    expect(visitsSummary({ visitsTotal: 3, timeSpentMs: 540_000 })).toBe("3 visits · 9:00");
    expect(visitLine(PAGE.visits[0], 4)).toBe("1:46 · 3 of 4 pages");
    expect(visitLine(PAGE.visits[1], null)).toBe("1 page");
    expect(visitLine({ ...PAGE.visits[0], kind: "image", timeSpentMs: null, pagesSeen: null }, null)).toBe("");
  });

  it("shows the totals, a bar a page with skipped pages greyed, the visits, and pages through the rest", async () => {
    invokeMock.mockResolvedValueOnce(PAGE).mockResolvedValueOnce({
      ...PAGE,
      visits: [{ startedAt: "2026-11-01T09:00:00Z", lastSeenAt: "2026-11-01T09:00:00Z", kind: "document", timeSpentMs: 5_000, pagesSeen: 1 }],
      nextBefore: null,
    });
    renderIt();
    expect(await screen.findByText("3 visits · 9:00")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("share_viewer_visits", { shareToken: "tok", viewerId: PAGE.viewerId, before: null });
    const bars = within(screen.getByRole("list", { name: "Time per page" })).getAllByRole("listitem");
    expect(bars).toHaveLength(4);
    expect(bars[2]).toHaveTextContent("Page 3, not seen");
    expect(within(screen.getByRole("list", { name: "Visits" })).getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Show more visits" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_viewer_visits", { shareToken: "tok", viewerId: PAGE.viewerId, before: "cursor-1" }),
    );
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Visits" })).getAllByRole("listitem")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Show more visits" })).toBeNull();
  });

  it("draws no page bars without a document's page times", async () => {
    invokeMock.mockResolvedValue({ ...PAGE, pageTimeMs: null, nextBefore: null });
    renderIt();
    await screen.findByText("3 visits · 9:00");
    expect(screen.queryByRole("list", { name: "Time per page" })).toBeNull();
  });

  it("says why it could not load, with Try again", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "share_viewer_visits"
        ? Promise.reject({ kind: "NotFound", message: "This viewer's visits aren't available any more." })
        : Promise.resolve(undefined),
    );
    renderIt();
    expect(await screen.findByText(/aren't available any more/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

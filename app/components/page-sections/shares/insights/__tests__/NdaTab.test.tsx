import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { acceptsNewestFirst, EARLIER_TEXT, NdaTab, NO_ACCEPTS, TEXT_NOT_HERE, useNdaAccepts } from "../NdaTab";
import type { NdaAccept, NdaAccepts } from "@/app/lib/tauri/shareNda";
import { ANONYMOUS } from "../insightsView";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const accept = (id: number, viewerId: string, at: string, more: Partial<NdaAccept> = {}): NdaAccept => ({
  id,
  viewerId,
  email: null,
  acceptedAt: at,
  earlier: false,
  ...more,
});

const PAGE: NdaAccepts = {
  offered: true,
  hasText: true,
  text: "Keep it to yourself.",
  accepts: [
    accept(1, "v-old", "2026-11-01T10:00:00Z", { earlier: true }),
    accept(2, "v-named", "2026-11-09T10:00:00Z"),
    accept(3, "v-mail", "2026-11-10T10:00:00Z", { email: "alice@acme.com" }),
  ],
  nextAfter: null,
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

function Tab({ names = {} }: { names?: Record<string, string | null> }) {
  const state = useNdaAccepts("tok");
  return state.shown ? <NdaTab state={state} viewerNames={names} /> : <p>no tab</p>;
}

function renderTab(names?: Record<string, string | null>) {
  const Wrapper = wrapper();
  render(
    <Wrapper>
      <Tab names={names} />
    </Wrapper>,
  );
}

describe("the NDA tab", () => {
  beforeEach(() => invokeMock.mockReset());

  it("shows the text, then each accept newest first, named by proven email, then viewer name, else anonymous", async () => {
    invokeMock.mockResolvedValue(PAGE);
    renderTab({ "v-named": "Ahmad", "v-mail": "Someone else" });
    expect(await screen.findByTestId("nda-current-text")).toHaveTextContent("Keep it to yourself.");
    expect(invokeMock).toHaveBeenCalledWith("share_nda_accepts", { shareToken: "tok", after: 0 });

    const rows = screen.getAllByTestId("nda-accept");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("alice@acme.com"),
      expect.stringContaining("Ahmad"),
      expect.stringContaining(ANONYMOUS),
    ]);
    // Only the accept of an earlier text says so.
    expect(within(rows[2]).getByText(new RegExp(EARLIER_TEXT))).toBeInTheDocument();
    expect(within(rows[0]).queryByText(new RegExp(EARLIER_TEXT))).toBeNull();
  });

  it("has no tab without a text or an accept, or on a server without NDAs", async () => {
    invokeMock.mockResolvedValue({ ...PAGE, hasText: false, text: null, accepts: [] });
    renderTab();
    expect(await screen.findByText("no tab")).toBeInTheDocument();

    const { result } = renderHook(() => useNdaAccepts("tok2"), { wrapper: wrapper() });
    invokeMock.mockResolvedValue({ ...PAGE, offered: false });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.shown).toBe(false);
  });

  it("with a text and no accepts yet, says so in one line", async () => {
    invokeMock.mockResolvedValue({ ...PAGE, accepts: [] });
    renderTab();
    expect(await screen.findByText(NO_ACCEPTS)).toBeInTheDocument();
    expect(screen.queryAllByTestId("nda-accept")).toHaveLength(0);
  });

  it("lists accepts of a removed text, all as earlier, with no text section", async () => {
    invokeMock.mockResolvedValue({ ...PAGE, hasText: false, text: null, accepts: [accept(1, "v", "2026-11-01T10:00:00Z", { earlier: true })] });
    renderTab();
    expect(await screen.findByTestId("nda-accept")).toHaveTextContent(EARLIER_TEXT);
    expect(screen.queryByRole("region", { name: "NDA text" })).toBeNull();
  });

  it("says when the text can't be opened on this computer", async () => {
    invokeMock.mockResolvedValue({ ...PAGE, text: null });
    renderTab();
    expect(await screen.findByText(TEXT_NOT_HERE)).toBeInTheDocument();
  });

  it("loads the next page with Show more, after the last accept the server named", async () => {
    invokeMock.mockImplementation((_cmd: string, args?: { after?: number }) =>
      Promise.resolve(
        (args?.after ?? 0) === 0
          ? { ...PAGE, nextAfter: 3 }
          : { ...PAGE, accepts: [accept(4, "v-new", "2026-11-11T10:00:00Z")], nextAfter: null },
      ),
    );
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getAllByTestId("nda-accept")).toHaveLength(4));
    expect(invokeMock).toHaveBeenLastCalledWith("share_nda_accepts", { shareToken: "tok", after: 3 });
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    // The newest, from page two, comes first.
    expect(screen.getAllByTestId("nda-accept")[0]).toHaveTextContent(ANONYMOUS);
  });

  it("orders by time, then by id for accepts in the same moment", () => {
    const ordered = acceptsNewestFirst([
      { ...PAGE, accepts: [accept(5, "a", "2026-11-01T00:00:00Z"), accept(6, "b", "2026-11-01T00:00:00Z")] },
      { ...PAGE, accepts: [accept(7, "c", "2026-11-02T00:00:00Z")] },
    ]);
    expect(ordered.map((a) => a.id)).toEqual([7, 6, 5]);
  });
});

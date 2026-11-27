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
const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...args: unknown[]) => saveMock(...args) }));
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: () => Promise.resolve("/Users/me/Downloads"),
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Answers the accepts listing with `page` and the save commands as Rust would. */
function answer(page: NdaAccepts) {
  invokeMock.mockImplementation((cmd: string, args?: { acceptId?: number }) => {
    if (cmd === "share_nda_accepts") return Promise.resolve(page);
    if (cmd === "share_nda_accepts_csv_name") return Promise.resolve("Q3 report NDA accepts 2026-11-20.csv");
    if (cmd === "share_nda_record_name") return Promise.resolve(`Q3 report NDA record ${args?.acceptId}.txt`);
    return Promise.resolve(undefined);
  });
}

const accept = (id: number, viewerId: string, at: string, more: Partial<NdaAccept> = {}): NdaAccept => ({
  id,
  viewerId,
  email: null,
  signerName: null,
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
  return state.shown ? <NdaTab state={state} viewerNames={names} shareToken="tok" fileName="Q3 report.pdf" /> : <p>no tab</p>;
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
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
  });

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
    expect(within(rows[2]).getAllByText(new RegExp(EARLIER_TEXT)).length).toBeGreaterThan(0);
    expect(within(rows[0]).queryByText(new RegExp(EARLIER_TEXT))).toBeNull();
  });

  it("names a signer by the name they typed first, ahead of their email and the Viewers tab", async () => {
    invokeMock.mockResolvedValue({
      ...PAGE,
      accepts: [
        accept(3, "v-mail", "2026-11-10T10:00:00Z", { email: "alice@acme.com", signerName: "Alice Moreno" }),
        accept(2, "v-named", "2026-11-09T10:00:00Z", { signerName: "Dana Reyes" }),
      ],
    });
    renderTab({ "v-named": "Ahmad" });
    await screen.findByTestId("nda-current-text");
    const rows = screen.getAllByTestId("nda-accept");
    expect(rows[0]).toHaveTextContent("Alice Moreno");
    // Name and email both given: the name first, the email under it.
    expect(within(rows[0]).getByTestId("viewer-primary")).toHaveTextContent("Alice Moreno");
    expect(within(rows[0]).getByTestId("viewer-email")).toHaveTextContent("alice@acme.com");
    expect(rows[1]).toHaveTextContent("Dana Reyes");
    expect(rows[1]).not.toHaveTextContent("Ahmad");
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

  it("is a table with a Record on every accept, an earlier text's included", async () => {
    answer(PAGE);
    renderTab();
    const table = await screen.findByRole("table", { name: "Accepted" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Accepted", "Record"]);
    const rows = screen.getAllByTestId("nda-accept");
    expect(within(rows[0]).getByRole("button", { name: /Record/ })).toBeInTheDocument();
    expect(within(rows[1]).getByRole("button", { name: /Record/ })).toBeInTheDocument();
    expect(within(rows[2]).getByRole("button", { name: /Record/ })).toBeInTheDocument();
  });

  it("keeps the Record only on an earlier text's accept when the current text can't be opened here", async () => {
    answer({ ...PAGE, text: null });
    renderTab();
    await screen.findByRole("table", { name: "Accepted" });
    const rows = screen.getAllByTestId("nda-accept");
    expect(within(rows[0]).queryByRole("button", { name: /Record/ })).toBeNull();
    expect(within(rows[1]).queryByRole("button", { name: /Record/ })).toBeNull();
    expect(within(rows[2]).getByRole("button", { name: /Record/ })).toBeInTheDocument();
  });

  it("saves a record where the owner chooses, through Rust, by the accept's id", async () => {
    answer(PAGE);
    saveMock.mockResolvedValue("/Users/me/Downloads/rec.txt");
    renderTab();
    const rows = await screen.findAllByTestId("nda-accept");
    fireEvent.click(within(rows[0]).getByRole("button", { name: /Record/ }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_save_nda_record", {
        shareToken: "tok",
        fileName: "Q3 report.pdf",
        acceptId: 3,
        destination: "/Users/me/Downloads/rec.txt",
      }),
    );
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "/Users/me/Downloads/Q3 report NDA record 3.txt" }),
    );
  });

  it("exports every accept as CSV with the Viewers tab's names, and a dismissed dialog writes nothing", async () => {
    answer(PAGE);
    saveMock.mockResolvedValueOnce(null).mockResolvedValueOnce("/tmp/a.csv");
    renderTab({ "v-named": "Bob" });
    const exportButton = await screen.findByRole("button", { name: "Export" });
    fireEvent.click(exportButton);
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(exportButton).not.toBeDisabled());
    expect(invokeMock).not.toHaveBeenCalledWith("share_export_nda_accepts_csv", expect.anything());
    fireEvent.click(exportButton);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_export_nda_accepts_csv", {
        shareToken: "tok",
        fileName: "Q3 report.pdf",
        destination: "/tmp/a.csv",
        viewerNames: { "v-named": "Bob" },
      }),
    );
  });

  it("offers no Export while no one has accepted", async () => {
    answer({ ...PAGE, accepts: [] });
    renderTab();
    await screen.findByText(NO_ACCEPTS);
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
  });
});

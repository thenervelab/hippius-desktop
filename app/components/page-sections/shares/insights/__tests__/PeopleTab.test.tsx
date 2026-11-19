import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { NAMES_HIDDEN, PeopleTab, personFacts, UNNAMED_LINK, useGroupInsights, YOUR_LINK } from "../PeopleTab";
import type { GroupInsights } from "@/app/lib/tauri/shareRecipients";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const GROUP: GroupInsights = {
  offered: true,
  namesHidden: true,
  overVisitBudget: false,
  people: [
    { shareToken: "src", recipient: false, name: null, views: 1, viewers: 1, pages: null, emails: [] },
    { shareToken: "a", recipient: true, name: "Alice", views: 4, viewers: 2, pages: "9 of 12 pages", emails: ["alice@example.com"] },
    { shareToken: "b", recipient: true, name: null, views: 0, viewers: 0, pages: null, emails: [] },
  ],
};

function Harness() {
  const state = useGroupInsights("src");
  return state.shown ? <PeopleTab state={state} /> : <p>no tab</p>;
}

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("PeopleTab", () => {
  beforeEach(() => invokeMock.mockReset());

  it("lists each link of the group with its own numbers, pages and proved emails", async () => {
    invokeMock.mockResolvedValue(GROUP);
    renderIt();
    const rows = await screen.findAllByTestId("people-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(YOUR_LINK);
    expect(within(rows[0]).queryByRole("button", { name: /Revoke/ })).toBeNull();
    expect(rows[1]).toHaveTextContent("Alice");
    expect(rows[1]).toHaveTextContent("4 views · 2 viewers · 9 of 12 pages");
    expect(within(rows[1]).getByTestId("people-emails")).toHaveTextContent("alice@example.com");
    expect(rows[2]).toHaveTextContent(UNNAMED_LINK);
    expect(screen.getByText(NAMES_HIDDEN)).toBeInTheDocument();
  });

  it("has no tab when the link's file went to no one else", async () => {
    invokeMock.mockResolvedValue({ ...GROUP, offered: false, people: GROUP.people.slice(0, 1) });
    renderIt();
    expect(await screen.findByText("no tab")).toBeInTheDocument();
  });

  it("revokes one person's link after asking in the row", async () => {
    invokeMock.mockImplementation((cmd: string) => Promise.resolve(cmd === "share_group_insights" ? GROUP : undefined));
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke link for Alice" }));
    expect(invokeMock).not.toHaveBeenCalledWith("share_revoke_recipient_link", expect.anything());
    const row = screen.getAllByTestId("people-row")[1];
    fireEvent.click(within(row).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("share_revoke_recipient_link", { shareToken: "a" }));
  });

  it("words the numbers in the singular and plural", () => {
    expect(personFacts({ views: 1, viewers: 1, pages: null })).toBe("1 view · 1 viewer");
    expect(personFacts({ views: 0, viewers: 3, pages: "2 pages" })).toBe("0 views · 3 viewers · 2 pages");
  });
});

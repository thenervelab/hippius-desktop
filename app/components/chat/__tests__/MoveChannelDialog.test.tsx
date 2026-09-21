import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";

import { moveChannelAtom } from "@/components/chat/chat-ui-atoms";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import type { RoomSummary } from "@/lib/chat/rooms";

const moveChannelToCategory = vi.fn();
vi.mock("@/lib/chat/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/spaces")>()),
  moveChannelToCategory: (...args: unknown[]) => moveChannelToCategory(...args),
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const { default: MoveChannelDialog } = await import("@/components/chat/MoveChannelDialog");

const space = { roomId: "!acme" };
const client = { getUserId: () => "@me:hippius.com", getRoom: (id: string) => (id === "!acme" ? space : null) } as unknown as MatrixClient;

const channel = (id: string, name: string) => ({ id, name, kind: "channel", unread: 0, highlight: 0, muted: false }) as unknown as RoomSummary;
const backend = channel("!backend", "backend");
const general = channel("!general", "general");

const workspaces = {
  active: { id: "!acme", name: "Acme", canCreateChannels: true },
  channels: [general, backend],
  groups: {
    uncategorised: [general],
    categories: [
      { id: "!eng", name: "Engineering", channels: [backend] },
      { id: "!design", name: "Design", channels: [] },
    ],
  },
} as unknown as WorkspacesState;

function mount(roomId: string) {
  const store = createStore();
  store.set(moveChannelAtom, roomId);
  render(
    <Provider store={store}>
      <MoveChannelDialog client={client} workspaces={workspaces} />
    </Provider>,
  );
  return store;
}

describe("MoveChannelDialog", () => {
  beforeEach(() => {
    moveChannelToCategory.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it("ticks the channel's current category and refuses to move it there again", () => {
    mount("!backend");
    expect(screen.getByText(/Move #backend to/)).toBeInTheDocument();
    const current = screen.getByRole("button", { name: /Engineering/ });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current).toBeDisabled();
    expect(screen.getByRole("button", { name: /No category/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Design/ })).toBeEnabled();
  });

  it("moves the channel under the picked category, then closes", async () => {
    moveChannelToCategory.mockResolvedValue(undefined);
    const store = mount("!backend");
    fireEvent.click(screen.getByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(store.get(moveChannelAtom)).toBeNull());
    expect(moveChannelToCategory).toHaveBeenCalledWith(client, space, "!backend", "!design");
    expect(toast.success).toHaveBeenCalledWith("#backend moved to Design");
  });

  it("moving to 'No category' targets the workspace itself", async () => {
    moveChannelToCategory.mockResolvedValue(undefined);
    mount("!backend");
    fireEvent.click(screen.getByRole("button", { name: /No category/ }));
    await waitFor(() => expect(moveChannelToCategory).toHaveBeenCalledWith(client, space, "!backend", "!acme"));
    expect(toast.success).toHaveBeenCalledWith("#backend is no longer in a category");
  });

  it("keeps the dialog open and reports when the move fails", async () => {
    moveChannelToCategory.mockRejectedValue(new Error("Not allowed"));
    const store = mount("!backend");
    fireEvent.click(screen.getByRole("button", { name: /^Design/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not allowed"));
    expect(store.get(moveChannelAtom)).toBe("!backend");
  });
});

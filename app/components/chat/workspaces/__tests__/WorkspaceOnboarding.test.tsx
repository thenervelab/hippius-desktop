import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";

import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/chat/workspaces/CreateWorkspaceForm", () => ({ default: () => <div data-testid="create-form" /> }));
vi.mock("@/components/chat/workspaces/JoinWorkspaceList", () => ({ default: () => <div data-testid="join-list" /> }));

const { default: WorkspaceOnboarding } = await import("@/components/chat/workspaces/WorkspaceOnboarding");

const client = { getUserId: () => "@me:hippius.com" } as unknown as MatrixClient;
const workspaces = { invites: [], setActiveWorkspaceId: vi.fn() } as unknown as WorkspacesState;

describe("WorkspaceOnboarding", () => {
  it("offers a way to the existing conversations when the sidebar is not on screen", async () => {
    const onOpenConversations = vi.fn();
    render(<WorkspaceOnboarding client={client} workspaces={workspaces} onOpenConversations={onOpenConversations} />);
    fireEvent.click(screen.getByRole("button", { name: /open your conversations/i }));
    expect(onOpenConversations).toHaveBeenCalledTimes(1);
  });

  it("does not offer it when there is nothing to open or the sidebar is already visible", () => {
    render(<WorkspaceOnboarding client={client} workspaces={workspaces} />);
    expect(screen.queryByRole("button", { name: /open your conversations/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("create-form")).toBeInTheDocument();
    expect(screen.getByTestId("join-list")).toBeInTheDocument();
  });
});

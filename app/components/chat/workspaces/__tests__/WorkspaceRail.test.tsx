import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MatrixClient } from "matrix-js-sdk";

import WorkspaceRail, { workspaceRailLabel } from "@/components/chat/workspaces/WorkspaceRail";
import type { WorkspaceSummary } from "@/lib/chat/spaces";

// The tooltip primitive and the media hook reach for things jsdom lacks.
vi.mock("@/components/chat/ChatTooltip", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/chat/hooks/useMediaUrl", () => ({
  useMediaUrl: () => ({ status: "idle" }),
}));

const client = { getUserId: () => "@me:hippius.com" } as unknown as MatrixClient;

const ws = (id: string, name: string): WorkspaceSummary => ({
  id,
  name,
  topic: null,
  avatarMxc: null,
  memberCount: 3,
  myRole: "member",
  canCreateChannels: false,
  isPublic: false,
  isCommunity: false,
  canonicalAlias: null,
});

describe("WorkspaceRail", () => {
  it("renders one button per workspace with initials, marks the active one, and switches on click", async () => {
    const onSelect = vi.fn();
    render(
      <WorkspaceRail
        client={client}
        workspaces={[ws("!a", "Acme Corp"), ws("!b", "Hippius")]}
        invites={[]}
        badges={new Map()}
        activeWorkspaceId="!a"
        onSelect={onSelect}
      />,
    );
    const acme = screen.getByRole("button", { name: "Acme Corp" });
    expect(acme).toHaveAttribute("aria-current", "true");
    expect(acme).toHaveTextContent("AC");
    const hippius = screen.getByRole("button", { name: "Hippius" });
    expect(hippius).not.toHaveAttribute("aria-current");
    fireEvent.click(hippius);
    expect(onSelect).toHaveBeenCalledWith("!b");
  });

  it("puts mentions and unread into the accessible name and shows the count", () => {
    render(
      <WorkspaceRail
        client={client}
        workspaces={[ws("!a", "Acme"), ws("!b", "Beta")]}
        invites={[]}
        badges={
          new Map([
            ["!a", { unread: 4, highlight: 2 }],
            ["!b", { unread: 7, highlight: 0 }],
          ])
        }
        activeWorkspaceId="!a"
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Acme, 2 mentions" })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Beta, 7 unread" })).toBeInTheDocument();
  });

  it("shows pending Space invitations on the add button", () => {
    render(
      <WorkspaceRail
        client={client}
        workspaces={[]}
        invites={[{ id: "!s", name: "Team", avatarMxc: null, inviterId: null }]}
        badges={new Map()}
        activeWorkspaceId={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /add a workspace, 1 pending invitation/i })).toHaveTextContent("1");
  });
});

describe("workspaceRailLabel", () => {
  it("names the workspace and prefers mentions over plain unread", () => {
    expect(workspaceRailLabel("Acme", { unread: 0, highlight: 0 })).toBe("Acme");
    expect(workspaceRailLabel("Acme", { unread: 7, highlight: 0 })).toBe("Acme, 7 unread");
    expect(workspaceRailLabel("Acme", { unread: 7, highlight: 1 })).toBe("Acme, 1 mention");
    expect(workspaceRailLabel("Acme", { unread: 7, highlight: 3 })).toBe("Acme, 3 mentions");
  });
});

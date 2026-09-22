import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { MatrixClient, Room } from "matrix-js-sdk";

import { workspaceSettingsAtom } from "@/components/chat/chat-ui-atoms";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import type { RoomSummary } from "@/lib/chat/rooms";
import type {
  DeleteWorkspaceOutcome,
  RemoveMemberOutcome,
  WorkspaceMember,
  WorkspaceSummary,
} from "@/lib/chat/spaces";

const spaces = {
  setWorkspaceRole: vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  ),
  removeWorkspaceMember: vi.fn<
    (...args: unknown[]) => Promise<RemoveMemberOutcome>
  >(async () => ({
    revoked: ["!general"],
    failed: [],
    unreachable: [],
  })),
  reorderChannels: vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  ),
  setChannelDefault: vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  ),
  archiveChannel: vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  ),
  createCategory: vi.fn<(...args: unknown[]) => Promise<string>>(
    async () => "!newcat",
  ),
  renameCategory: vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  ),
  deleteCategory: vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  ),
  deleteWorkspace: vi.fn<
    (...args: unknown[]) => Promise<DeleteWorkspaceOutcome>
  >(async () => ({
    complete: true,
    membersLeft: [],
    unreachable: [],
    problems: [],
  })),
  leaveWorkspace: vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  ),
};
const members: WorkspaceMember[] = [
  {
    userId: "@me:hippius.com",
    displayName: "Me",
    avatarMxc: null,
    role: "owner",
    powerLevel: 100,
  },
  {
    userId: "@bob:hippius.com",
    displayName: "Bob",
    avatarMxc: null,
    role: "member",
    powerLevel: 0,
  },
];

vi.mock("@/lib/chat/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/spaces")>()),
  ...spaces,
  workspaceMembers: () => members,
  otherOwners: () => [],
  defaultChannelIds: () => ["!general"],
}));
const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/chat/hooks/useClientTick", () => ({
  useClientTick: () => 0,
}));
vi.mock("@/components/chat/hooks/useMediaUrl", () => ({
  useMediaUrl: () => ({ status: "idle" }),
}));

const { default: WorkspaceSettingsDialog } =
  await import("@/components/chat/workspaces/WorkspaceSettingsDialog");

// Lazy-loaded roster: the dialog must fetch it before showing or deciding anything.
let membersLoaded = false;
const loadMembersIfNeeded = vi.fn(async () => {
  membersLoaded = true;
  return true;
});
const space = {
  roomId: "!space",
  name: "Acme",
  membersLoaded: () => membersLoaded,
  loadMembersIfNeeded,
} as unknown as Room;
const engSpace = { roomId: "!eng", name: "Eng" } as unknown as Room;
const client = {
  getUserId: () => "@me:hippius.com",
  getRoom: (id: string) =>
    id === "!space" ? space : id === "!eng" ? engSpace : null,
  getUser: () => null,
  on: () => undefined,
  off: () => undefined,
  removeListener: () => undefined,
  mxcUrlToHttp: () => null,
} as unknown as MatrixClient;

const workspace = (myRole: WorkspaceSummary["myRole"]): WorkspaceSummary => ({
  id: "!space",
  name: "Acme",
  topic: null,
  avatarMxc: null,
  memberCount: 2,
  myRole,
  canCreateChannels: myRole !== "member",
  isPublic: false,
  isCommunity: false,
  canonicalAlias: null,
});
const channel = (id: string, name: string): RoomSummary =>
  ({
    id,
    name,
    topic: null,
    memberCount: 2,
    unread: 0,
    highlight: 0,
    muted: false,
  }) as RoomSummary;

const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const type = async (el: HTMLElement, value: string) => {
  await act(async () => {
    fireEvent.change(el, { target: { value } });
  });
};

function renderDialog(
  myRole: WorkspaceSummary["myRole"],
  tab: "general" | "members" | "channels" | "danger",
  withCategories = false,
) {
  const store = createStore();
  store.set(workspaceSettingsAtom, tab);
  const general = channel("!general", "general");
  const random = channel("!random", "random");
  const backend = channel("!backend", "backend");
  const state = {
    active: workspace(myRole),
    channels: withCategories ? [general, random, backend] : [general, random],
    groups: withCategories
      ? {
          uncategorised: [general, random],
          categories: [
            { id: "!eng", name: "Eng", channels: [backend] },
            { id: "!design", name: "Design", channels: [] },
          ],
        }
      : { uncategorised: [general, random], categories: [] },
    workspaces: [workspace(myRole)],
    invites: [],
    setActiveWorkspaceId: vi.fn(),
  } as unknown as WorkspacesState;
  render(
    <JotaiProvider store={store}>
      <WorkspaceSettingsDialog client={client} workspaces={state} />
    </JotaiProvider>,
  );
  return store;
}

describe("WorkspaceSettingsDialog", () => {
  beforeEach(() => {
    Object.values(spaces).forEach((fn) => fn.mockClear());
    Object.values(toast).forEach((fn) => fn.mockClear());
    membersLoaded = false;
    loadMembersIfNeeded.mockClear();
  });

  it("fetches the full roster before listing members, and shows a skeleton meanwhile", async () => {
    let release: () => void = () => undefined;
    loadMembersIfNeeded.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            membersLoaded = true;
            resolve(true);
          };
        }),
    );
    renderDialog("owner", "members");
    const list = await screen.findByRole("list", { name: "Members" });
    expect(list).toHaveAttribute("aria-busy", "true");
    expect(within(list).queryByText("Bob")).not.toBeInTheDocument();
    await act(async () => release());
    expect(await within(list).findByText("Bob")).toBeInTheDocument();
    expect(list).toHaveAttribute("aria-busy", "false");
    expect(loadMembersIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when the roster cannot be loaded", async () => {
    loadMembersIfNeeded.mockRejectedValueOnce(new Error("M_LIMIT_EXCEEDED"));
    renderDialog("owner", "members");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "M_LIMIT_EXCEEDED",
    );
    await click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not let an owner leave until the other owners are known", async () => {
    let release: () => void = () => undefined;
    loadMembersIfNeeded.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            membersLoaded = true;
            resolve(true);
          };
        }),
    );
    renderDialog("owner", "danger");
    const leave = await screen.findByRole("button", {
      name: "Leave workspace",
    });
    // Not yet decided: the button waits, the sole-owner verdict is not shown.
    expect(leave).toBeDisabled();
    expect(leave).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByText(/you are the only owner/i),
    ).not.toBeInTheDocument();
    await act(async () => release());
    // otherOwners is mocked to [] with two members: sole owner, so the guard applies.
    expect(
      await screen.findByText(/you are the only owner/i),
    ).toBeInTheDocument();
    expect(leave).toBeDisabled();
    expect(leave).not.toHaveAttribute("aria-busy", "true");
  });

  it("lets an owner change a role and remove a member, never themselves", async () => {
    renderDialog("owner", "members");
    const list = await screen.findByRole("list", { name: "Members" });
    expect(await within(list).findByText("Bob")).toBeInTheDocument();
    expect(within(list).queryByLabelText("Role of Me")).toBeNull();
    expect(within(list).queryByLabelText("Remove Me")).toBeNull();

    await type(within(list).getByLabelText("Role of Bob"), "admin");
    expect(spaces.setWorkspaceRole).toHaveBeenCalledWith(
      client,
      space,
      "@bob:hippius.com",
      "admin",
    );

    await click(within(list).getByLabelText("Remove Bob"));
    await click(await screen.findByRole("button", { name: "Remove" }));
    expect(spaces.removeWorkspaceMember).toHaveBeenCalledWith(
      client,
      space,
      "@bob:hippius.com",
    );
    expect(toast.success).toHaveBeenCalledWith("Bob was removed");
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("warns when a removed member is still in channels the kick could not clear", async () => {
    spaces.removeWorkspaceMember.mockResolvedValueOnce({
      revoked: ["!general"],
      failed: [{ roomId: "!random", message: "M_FORBIDDEN" }],
      unreachable: ["!secret"],
    });
    renderDialog("owner", "members");
    const list = await screen.findByRole("list", { name: "Members" });
    await click(await within(list).findByLabelText("Remove Bob"));
    await click(await screen.findByRole("button", { name: "Remove" }));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining("still in !random, !secret"),
      expect.anything(),
    );
  });

  it("hides the Channels tab and the controls from a plain member", async () => {
    renderDialog("member", "members");
    expect(screen.queryByRole("button", { name: "Channels" })).toBeNull();
    const list = await screen.findByRole("list", { name: "Members" });
    expect(await within(list).findByText("Bob")).toBeInTheDocument();
    expect(within(list).queryByLabelText("Role of Bob")).toBeNull();
    expect(within(list).queryByLabelText("Remove Bob")).toBeNull();
    expect(screen.queryByRole("button", { name: /invite/i })).toBeNull();
  });

  it("reorders, toggles default and archives channels", async () => {
    renderDialog("admin", "channels");
    const list = await screen.findByRole("list", { name: "Channels" });
    expect(within(list).getByLabelText("Move #general up")).toBeDisabled();

    await click(within(list).getByLabelText("Move #general down"));
    expect(spaces.reorderChannels).toHaveBeenCalledWith(client, space, [
      "!random",
      "!general",
    ]);

    await click(within(list).getByLabelText("Make #random a default channel"));
    expect(spaces.setChannelDefault).toHaveBeenCalledWith(
      client,
      space,
      "!random",
      true,
    );

    await click(within(list).getByLabelText("Archive #random"));
    await click(await screen.findByRole("button", { name: "Archive" }));
    expect(spaces.archiveChannel).toHaveBeenCalledWith(
      client,
      "!space",
      "!random",
    );
  });

  it("creates, renames, reorders and deletes categories, and reorders a category's channels in that category", async () => {
    renderDialog("admin", "channels", true);
    const list = await screen.findByRole("list", { name: "Channels" });

    // A category's channels are ordered within the category Space, not the workspace.
    expect(within(list).getByLabelText("Move #backend up")).toBeDisabled();
    expect(within(list).getByLabelText("Move #backend down")).toBeDisabled();
    await click(within(list).getByLabelText("Move #general down"));
    expect(spaces.reorderChannels).toHaveBeenLastCalledWith(client, space, [
      "!random",
      "!general",
    ]);

    // Categories are ordered among themselves in the workspace.
    expect(within(list).getByLabelText("Move Eng up")).toBeDisabled();
    await click(within(list).getByLabelText("Move Eng down"));
    expect(spaces.reorderChannels).toHaveBeenLastCalledWith(client, space, [
      "!design",
      "!eng",
    ]);

    await click(screen.getByRole("button", { name: "New category" }));
    await type(screen.getByLabelText("Category name"), " Ops ");
    await click(screen.getByRole("button", { name: "Create" }));
    expect(spaces.createCategory).toHaveBeenCalledWith(client, space, "Ops");

    await click(within(list).getByLabelText("Rename Eng"));
    const field = within(list).getByLabelText("Name of Eng");
    await type(field, "Engineering");
    await act(async () => {
      fireEvent.submit(field.closest("form") as HTMLFormElement);
    });
    expect(spaces.renameCategory).toHaveBeenCalledWith(
      client,
      "!eng",
      "Engineering",
    );

    await click(within(list).getByLabelText("Delete Eng"));
    expect(
      await screen.findByText(/Its 1 channel stay in Acme, uncategorised/),
    ).toBeTruthy();
    await click(screen.getByRole("button", { name: "Delete category" }));
    expect(spaces.deleteCategory).toHaveBeenCalledWith(client, space, "!eng");
  });

  it("requires the owner to type the name before deleting; members cannot delete", async () => {
    renderDialog("owner", "danger");
    await click(
      await screen.findByRole("button", { name: /delete workspace/i }),
    );
    const confirm = await screen.findByRole("button", {
      name: "Delete workspace",
    });
    expect(confirm).toBeDisabled();
    await type(
      screen.getByLabelText("Type the workspace name to confirm"),
      "Acme",
    );
    expect(confirm).toBeEnabled();
    await click(confirm);
    expect(spaces.deleteWorkspace).toHaveBeenCalledWith(client, space);
    expect(toast.success).toHaveBeenCalledWith("Acme was deleted");
  });

  it("reports what survived an incomplete deletion instead of a clean success", async () => {
    spaces.deleteWorkspace.mockResolvedValueOnce({
      complete: false,
      membersLeft: [
        {
          roomId: "!random",
          userId: "@bob:hippius.com",
          message: "M_FORBIDDEN",
        },
      ],
      unreachable: ["!secret"],
      problems: ["Could not close #random: M_FORBIDDEN"],
    });
    renderDialog("owner", "danger");
    await click(
      await screen.findByRole("button", { name: /delete workspace/i }),
    );
    await type(
      screen.getByLabelText("Type the workspace name to confirm"),
      "Acme",
    );
    await click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(toast.success).not.toHaveBeenCalled();
    const [message] = toast.warning.mock.calls[0];
    expect(message).toContain("1 person is still in !random");
    expect(message).toContain("!secret could not be reached");
    expect(message).toContain("Could not close #random");
  });

  it("offers a member only leave", async () => {
    renderDialog("member", "danger");
    expect(
      await screen.findByRole("button", { name: "Leave workspace" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /delete workspace/i }),
    ).toBeNull();
  });
});

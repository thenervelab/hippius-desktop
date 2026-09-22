"use client";

import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { RoomEvent, RoomMemberEvent, RoomStateEvent } from "matrix-js-sdk";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  Building2,
  Check,
  FolderPlus,
  Hash,
  ImagePlus,
  Pencil,
  Settings,
  Star,
  StarOff,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  createChannelCategoryAtom,
  createChannelOpenAtom,
  invitePeopleOpenAtom,
  selectedRoomIdAtom,
  type WorkspaceSettingsTab,
  workspaceSettingsAtom,
} from "@/components/chat/chat-ui-atoms";
import {
  dialogContentClassName,
  dialogTabPanelClassName,
  dialogTabsClassName,
  dialogTitleClassName,
} from "@/components/chat/dialog-styles";
import { useClientTick } from "@/components/chat/hooks/useClientTick";
import { useRoomRoster } from "@/components/chat/hooks/useRoomRoster";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import UserAvatar from "@/components/chat/UserAvatar";
import WorkspaceAvatar from "@/components/chat/workspaces/WorkspaceAvatar";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
import type { RoomSummary } from "@/lib/chat/rooms";
import {
  archiveChannel,
  type CategoryChannels,
  createCategory,
  defaultChannelIds,
  deleteCategory,
  deleteWorkspace,
  isSpaceRoom,
  leaveWorkspace,
  otherOwners,
  removeWorkspaceMember,
  renameCategory,
  reorderChannels,
  ROLE_LABEL,
  setChannelDefault,
  setWorkspaceRole,
  updateWorkspaceProfile,
  uploadAvatar,
  type WorkspaceChannelGroups,
  type WorkspaceMember,
  workspaceMembers,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@/lib/chat/spaces";
import { cn } from "@/lib/utils";

const TABS: {
  id: WorkspaceSettingsTab;
  label: string;
  icon: typeof Users;
  adminOnly?: boolean;
}[] = [
  { id: "general", label: "General", icon: Building2 },
  { id: "members", label: "Members", icon: Users },
  { id: "channels", label: "Channels", icon: Hash, adminOnly: true },
  { id: "danger", label: "Danger zone", icon: AlertTriangle },
];

const FIELD =
  "w-full rounded-md border border-grey-80 bg-white px-2.5 py-1.5 text-sm text-grey-10 outline-none placeholder:text-grey-60 focus:border-primary-50 disabled:opacity-60 dark:border-black-300 dark:bg-black-300 dark:text-grey-light-100 dark:placeholder:text-grey-dark-700 dark:focus:border-primary-40";
const SMALL_BUTTON =
  "inline-flex items-center gap-1.5 rounded-md border border-grey-80 px-2.5 py-1 text-xs font-medium text-grey-10 hover:bg-grey-90 disabled:opacity-50 dark:border-black-300 dark:text-grey-light-100 dark:hover:bg-black-300";
const ICON_BUTTON =
  "inline-flex size-7 items-center justify-center rounded-md text-grey-60 outline-none hover:bg-grey-90 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 disabled:opacity-40 disabled:hover:bg-transparent dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40";
const LABEL = "text-sm font-medium text-grey-dark-800 dark:text-grey-dark-200";
const HINT = "mt-1 text-xs text-grey-60 dark:text-grey-dark-700";
const GROUP_HEADER =
  "bg-grey-light-600 px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-grey-30 dark:bg-black-primary-bg dark:text-grey-dark-200";
const DANGER_ICON_BG = "bg-[#fc7d73]";

/** "#general, #random and 2 more" for a toast about several channels. */
export function channelNames(
  client: MatrixClient,
  roomIds: readonly string[],
  max = 3,
): string {
  const names = roomIds.map((id) => {
    const room = client.getRoom(id);
    if (!room) return id;
    return isSpaceRoom(room) ? room.name : `#${room.name}`;
  });
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** Who may do what. Owners: everything. Admins: everything but roles and delete. */
export function can(role: WorkspaceRole) {
  return {
    editProfile: role !== "member",
    invite: role !== "member",
    manageChannels: role !== "member",
    changeRoles: role === "owner",
    remove: role !== "member",
    delete: role === "owner",
  };
}

type Perms = ReturnType<typeof can>;

/**
 * Workspace settings: General (name, description, picture), Members (roles,
 * remove), Channels (default, order, categories, archive), Danger zone
 * (leave, delete). Members see General and Danger zone with the controls
 * they are allowed; admins and owners get the rest. Opened from the
 * sidebar's workspace menu. Ported from the console; every confirmation is
 * the app's `ConfirmationDialog`.
 */
export default function WorkspaceSettingsDialog({
  client,
  workspaces,
}: {
  client: MatrixClient;
  workspaces: WorkspacesState;
}) {
  const [tab, setTabAtom] = useAtom(workspaceSettingsAtom);
  const active = workspaces.active;
  const open = tab !== null && active !== null;
  const close = () => setTabAtom(null);
  const role = active?.myRole ?? "member";
  const perms = can(role);
  const tabs = TABS.filter((t) => !t.adminOnly || perms.manageChannels);
  const current: WorkspaceSettingsTab =
    tab && tabs.some((t) => t.id === tab) ? tab : "general";

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title={<span title={active?.name}>{active?.name ?? "Workspace"}</span>}
      icon={<Settings className="size-[17px] text-white" aria-hidden />}
      maxWidth="max-w-[760px]"
      contentClassName={dialogContentClassName}
      titleClassName={dialogTitleClassName}
    >
      {active ? (
        <div className={dialogTabsClassName}>
          <nav
            className="flex shrink-0 gap-1 overflow-x-auto sm:w-40 sm:flex-col"
            aria-label="Workspace settings sections"
          >
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTabAtom(id)}
                aria-current={current === id ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-grey-10 hover:bg-grey-90 dark:text-grey-light-100 dark:hover:bg-black-300",
                  current === id && "bg-grey-90 font-medium dark:bg-black-300",
                  id === "danger" && "text-error-50 dark:text-error-50",
                )}
              >
                <Icon
                  className={cn(
                    "size-4 shrink-0 text-grey-60 dark:text-grey-dark-700",
                    id === "danger" && "text-error-50 dark:text-error-50",
                  )}
                  aria-hidden
                />
                {label}
              </button>
            ))}
          </nav>
          <div className={dialogTabPanelClassName}>
            {current === "general" ? (
              <GeneralTab
                key={active.id}
                client={client}
                workspace={active}
                canEdit={perms.editProfile}
              />
            ) : null}
            {current === "members" ? (
              <MembersTab
                key={active.id}
                client={client}
                workspace={active}
                perms={perms}
                onClose={close}
              />
            ) : null}
            {current === "channels" ? (
              <ChannelsTab
                key={active.id}
                client={client}
                workspace={active}
                channels={workspaces.channels}
                groups={workspaces.groups}
                onClose={close}
              />
            ) : null}
            {current === "danger" ? (
              <DangerTab
                key={active.id}
                client={client}
                workspace={active}
                perms={perms}
                onClose={close}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </FramedDialog>
  );
}

// ---------------------------------------------------------------- general --

function GeneralTab({
  client,
  workspace,
  canEdit,
}: {
  client: MatrixClient;
  workspace: WorkspaceSummary;
  canEdit: boolean;
}) {
  const [name, setName] = useState(workspace.name);
  const [topic, setTopic] = useState(workspace.topic ?? "");
  const [busy, setBusy] = useState<"save" | "avatar" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty =
    name.trim() !== workspace.name || topic.trim() !== (workspace.topic ?? "");

  const save = async () => {
    const space = client.getRoom(workspace.id);
    if (!space || !name.trim()) return;
    setBusy("save");
    try {
      await updateWorkspaceProfile(client, space, { name, topic });
      toast.success("Workspace updated");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not update the workspace",
      );
    } finally {
      setBusy(null);
    }
  };

  const changeAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const space = client.getRoom(workspace.id);
    if (!file || !space) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Pick an image under 2 MB");
      return;
    }
    setBusy("avatar");
    try {
      const mxc = await uploadAvatar(client, file);
      await updateWorkspaceProfile(client, space, { avatarMxc: mxc });
      toast.success("Picture updated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update the picture",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <WorkspaceAvatar
          client={client}
          name={workspace.name}
          avatarMxc={workspace.avatarMxc}
          size={56}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-grey-10 dark:text-grey-light-100">
            {workspace.name}
          </p>
          <p className="text-xs text-grey-60 dark:text-grey-dark-700">
            {workspace.memberCount} member
            {workspace.memberCount === 1 ? "" : "s"} · you are{" "}
            {ROLE_LABEL[workspace.myRole].toLowerCase()}
            {workspace.isCommunity ? " · public community" : ""}
          </p>
          {canEdit ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={changeAvatar}
                aria-label="Workspace picture"
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy !== null}
                className={cn(SMALL_BUTTON, "mt-2")}
              >
                <ImagePlus className="size-3.5" aria-hidden />{" "}
                {busy === "avatar" ? "Uploading…" : "Change picture"}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div>
        <label htmlFor="ws-settings-name" className={LABEL}>
          Name
        </label>
        <input
          id="ws-settings-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canEdit || busy !== null}
          maxLength={80}
          className={cn(FIELD, "mt-1.5")}
        />
      </div>
      <div>
        <label htmlFor="ws-settings-topic" className={LABEL}>
          Description
        </label>
        <textarea
          id="ws-settings-topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={!canEdit || busy !== null}
          maxLength={250}
          rows={3}
          className={cn(FIELD, "mt-1.5 resize-none")}
          placeholder={
            canEdit ? "What is this workspace for?" : "No description"
          }
        />
      </div>
      {canEdit ? (
        <Button
          variant="primary"
          size="sm"
          onClick={() => void save()}
          disabled={!dirty || !name.trim() || busy !== null}
          loading={busy === "save"}
        >
          Save changes
        </Button>
      ) : (
        <p className={HINT}>Only admins and owners can edit the workspace.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- members --

const MEMBER_EVENTS = [
  RoomStateEvent.Members,
  RoomMemberEvent.PowerLevel,
  RoomEvent.MyMembership,
] as const;

function MembersTab({
  client,
  workspace,
  perms,
  onClose,
}: {
  client: MatrixClient;
  workspace: WorkspaceSummary;
  perms: Perms;
  onClose: () => void;
}) {
  const setInviteOpen = useSetAtom(invitePeopleOpenAtom);
  const tick = useClientTick(client, MEMBER_EVENTS);
  const me = client.getUserId() ?? "";
  // Sync only sent the members who spoke; the rest arrive with the roster.
  const roster = useRoomRoster(client, workspace.id);
  const members = useMemo(() => {
    const space = client.getRoom(workspace.id);
    return space ? workspaceMembers(space) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspace.id, tick, roster.loaded]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null);

  const q = filter.trim().toLowerCase();
  const shown = members.filter(
    (m) =>
      !q ||
      m.displayName.toLowerCase().includes(q) ||
      m.userId.toLowerCase().includes(q),
  );
  const owners = members.filter((m) => m.role === "owner").length;

  const changeRole = async (member: WorkspaceMember, role: WorkspaceRole) => {
    const space = client.getRoom(workspace.id);
    if (!space || role === member.role || !roster.loaded) return;
    if (member.role === "owner" && role !== "owner" && owners === 1) {
      toast.error(
        "A workspace needs at least one owner. Make someone else an owner first.",
      );
      return;
    }
    setBusy(member.userId);
    try {
      await setWorkspaceRole(client, space, member.userId, role);
      toast.success(
        `${member.displayName} is now ${ROLE_LABEL[role].toLowerCase()}`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not change the role",
      );
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const space = client.getRoom(workspace.id);
    if (!space || !removing) return;
    setBusy(removing.userId);
    try {
      const outcome = await removeWorkspaceMember(
        client,
        space,
        removing.userId,
      );
      const stillIn = [
        ...outcome.failed.map((f) => f.roomId),
        ...outcome.unreachable,
      ];
      if (stillIn.length === 0) {
        toast.success(`${removing.displayName} was removed`);
      } else {
        // Out of the Space, but a channel kick failed or we are not in that
        // channel: they can still read and post there until someone who is
        // removes them. Say so instead of claiming a clean removal.
        toast.warning(
          `${removing.displayName} was removed from ${workspace.name} but is still in ${channelNames(client, stillIn)}.`,
          {
            duration: 10_000,
          },
        );
      }
      setRemoving(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not remove the member",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={
            roster.loaded
              ? `Search ${members.length} member${members.length === 1 ? "" : "s"}`
              : "Search members"
          }
          aria-label="Search members"
          className={FIELD}
        />
        {perms.invite ? (
          <Button
            variant="primary"
            size="sm"
            className="h-9 shrink-0 gap-1.5"
            onClick={() => {
              onClose();
              setInviteOpen(true);
            }}
          >
            <UserPlus className="size-4" aria-hidden /> Invite
          </Button>
        ) : null}
      </div>
      {roster.error ? (
        <p
          role="alert"
          className="flex items-center justify-between gap-2 rounded-md border border-error-50/40 bg-error-50/5 px-2.5 py-2 text-xs text-error-50 dark:bg-error-50/10"
        >
          <span>Could not load the member list: {roster.error}</span>
          <button
            type="button"
            onClick={roster.retry}
            className="font-medium underline-offset-2 hover:underline"
          >
            Retry
          </button>
        </p>
      ) : null}
      <ul
        className="divide-y divide-grey-80 rounded-md border border-grey-80 dark:divide-black-300 dark:border-black-300"
        aria-label="Members"
        aria-busy={!roster.loaded && !roster.error}
      >
        {!roster.loaded && !roster.error
          ? // Skeleton rows while /members is in flight: the partial list we
            // have would show people without their teammates and invite
            // decisions on a roster that is not there yet.
            [0, 1, 2].map((i) => (
              <li
                key={i}
                className="flex items-center gap-2.5 px-2.5 py-2"
                aria-hidden
              >
                <span className="size-8 shrink-0 animate-pulse rounded-full bg-grey-90 dark:bg-black-300" />
                <span className="flex-1 space-y-1.5">
                  <span className="block h-3 w-1/3 animate-pulse rounded bg-grey-90 dark:bg-black-300" />
                  <span className="block h-2.5 w-1/2 animate-pulse rounded bg-grey-90 dark:bg-black-300" />
                </span>
              </li>
            ))
          : null}
        {roster.loaded
          ? shown.map((member) => {
              const isMe = member.userId === me;
              // Owners can change anyone; nobody edits themselves or an owner unless owner.
              const roleEditable = perms.changeRoles && !isMe;
              const removable =
                perms.remove && !isMe && member.role !== "owner";
              return (
                <li
                  key={member.userId}
                  className="flex items-center gap-2.5 px-2.5 py-2"
                >
                  <UserAvatar
                    client={client}
                    seed={member.userId}
                    avatarMxc={member.avatarMxc}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-sm font-medium text-grey-10 dark:text-grey-light-100"
                      title={member.displayName}
                    >
                      {member.displayName}
                      {isMe ? (
                        <span className="ml-1 text-xs font-normal text-grey-60 dark:text-grey-dark-700">
                          (you)
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-[11px] text-grey-60 dark:text-grey-dark-700">
                      {member.userId}
                    </p>
                  </div>
                  {roleEditable ? (
                    <select
                      value={member.role}
                      onChange={(e) =>
                        void changeRole(member, e.target.value as WorkspaceRole)
                      }
                      disabled={busy !== null}
                      aria-label={`Role of ${member.displayName}`}
                      className={cn(FIELD, "w-auto py-1 text-xs")}
                    >
                      {(Object.keys(ROLE_LABEL) as WorkspaceRole[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="rounded-md bg-grey-90 px-2 py-0.5 text-[11px] font-medium text-grey-30 dark:bg-black-300 dark:text-grey-dark-200">
                      {ROLE_LABEL[member.role]}
                    </span>
                  )}
                  {removable ? (
                    <button
                      type="button"
                      onClick={() => setRemoving(member)}
                      disabled={busy !== null}
                      aria-label={`Remove ${member.displayName}`}
                      className={ICON_BUTTON}
                    >
                      <UserMinus className="size-4" aria-hidden />
                    </button>
                  ) : null}
                </li>
              );
            })
          : null}
        {roster.loaded && shown.length === 0 ? (
          <li className="px-2.5 py-3 text-center text-xs text-grey-60 dark:text-grey-dark-700">
            Nobody matches.
          </li>
        ) : null}
      </ul>

      <ConfirmationDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onBack={() => setRemoving(null)}
        onConfirm={() => void remove()}
        heading="Remove from workspace"
        text={
          removing
            ? `${removing.displayName} will be removed from ${workspace.name} and all of its channels. They can be invited again later.`
            : ""
        }
        button="Remove"
        disableButton={busy !== null}
        icon={<UserMinus className="size-5 text-white" aria-hidden />}
        iconBgColor={DANGER_ICON_BG}
        confirmVariant="destructive"
      />
    </div>
  );
}

// --------------------------------------------------------------- channels --

const CHANNEL_EVENTS = [RoomStateEvent.Events, RoomEvent.MyMembership] as const;

function ChannelsTab({
  client,
  workspace,
  channels,
  groups,
  onClose,
}: {
  client: MatrixClient;
  workspace: WorkspaceSummary;
  channels: RoomSummary[];
  groups: WorkspaceChannelGroups;
  onClose: () => void;
}) {
  const setCreateOpen = useSetAtom(createChannelOpenAtom);
  const setCreateCategory = useSetAtom(createChannelCategoryAtom);
  const [selectedRoomId, setSelectedRoomId] = useAtom(selectedRoomIdAtom);
  const tick = useClientTick(client, CHANNEL_EVENTS);
  const defaults = useMemo(() => {
    const space = client.getRoom(workspace.id);
    return new Set(space ? defaultChannelIds(client, space) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspace.id, tick, channels]);
  const [busy, setBusy] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<RoomSummary | null>(null);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<CategoryChannels | null>(null);
  const hasCategories = groups.categories.length > 0;

  const run = async (
    key: string,
    label: string,
    action: () => Promise<void>,
  ) => {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not ${label}`,
      );
    } finally {
      setBusy(null);
    }
  };

  /** Swap two neighbours in whichever Space lists them (`containerId`). */
  const move = (
    containerId: string,
    list: readonly { id: string }[],
    index: number,
    delta: -1 | 1,
    label: string,
  ) => {
    const container = client.getRoom(containerId);
    const target = index + delta;
    if (!container || target < 0 || target >= list.length) return;
    const ids = list.map((c) => c.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void run(ids[target], label, () => reorderChannels(client, container, ids));
  };

  const toggleDefault = (room: RoomSummary) => {
    const space = client.getRoom(workspace.id);
    if (!space) return;
    void run(room.id, "update the channel", () =>
      setChannelDefault(client, space, room.id, !defaults.has(room.id)),
    );
  };

  const archive = async () => {
    if (!archiving) return;
    const room = archiving;
    await run(room.id, "archive the channel", async () => {
      await archiveChannel(client, workspace.id, room.id);
      if (selectedRoomId === room.id) setSelectedRoomId(null);
      toast.success(`#${room.name} archived`);
      setArchiving(null);
    });
  };

  const submitNewCategory = async () => {
    const space = client.getRoom(workspace.id);
    const name = newCategory?.trim() ?? "";
    if (!space || !name) return;
    await run("new-category", "create the category", async () => {
      await createCategory(client, space, name);
      toast.success(`${name} created`);
      setNewCategory(null);
    });
  };

  const submitRename = async () => {
    if (!renaming) return;
    const { id, name } = renaming;
    const trimmed = name.trim();
    const current = groups.categories.find((c) => c.id === id);
    if (!trimmed || !current || trimmed === current.name) {
      setRenaming(null);
      return;
    }
    await run(id, "rename the category", async () => {
      await renameCategory(client, id, trimmed);
      setRenaming(null);
    });
  };

  const removeCategory = async () => {
    const space = client.getRoom(workspace.id);
    if (!deleting || !space) return;
    const category = deleting;
    await run(category.id, "delete the category", async () => {
      await deleteCategory(client, space, category.id);
      toast.success(
        category.channels.length > 0
          ? `${category.name} deleted; its channels are back at the top of the list`
          : `${category.name} deleted`,
      );
      setDeleting(null);
    });
  };

  const openCreateChannel = (categoryId: string | null) => {
    onClose();
    setCreateCategory(categoryId);
    setCreateOpen(true);
  };

  const channelRow = (
    containerId: string,
    list: RoomSummary[],
    room: RoomSummary,
    index: number,
  ) => {
    const isDefault = defaults.has(room.id);
    return (
      <li key={room.id} className="flex items-center gap-2 px-2.5 py-2">
        <Hash
          className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-medium text-grey-10 dark:text-grey-light-100"
            title={room.name}
          >
            {room.name}
            {isDefault ? (
              <span className="ml-1.5 rounded bg-primary-50/10 px-1.5 py-0.5 text-[10px] font-medium text-primary-50 dark:bg-primary-40/15 dark:text-primary-40">
                default
              </span>
            ) : null}
          </p>
          <p className="truncate text-[11px] text-grey-60 dark:text-grey-dark-700">
            {room.memberCount} member{room.memberCount === 1 ? "" : "s"}
            {room.topic ? ` · ${room.topic}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            move(containerId, list, index, -1, "reorder the channels")
          }
          disabled={busy !== null || index === 0}
          aria-label={`Move #${room.name} up`}
          className={ICON_BUTTON}
        >
          <ArrowUp className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() =>
            move(containerId, list, index, 1, "reorder the channels")
          }
          disabled={busy !== null || index === list.length - 1}
          aria-label={`Move #${room.name} down`}
          className={ICON_BUTTON}
        >
          <ArrowDown className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => toggleDefault(room)}
          disabled={busy !== null}
          aria-label={
            isDefault
              ? `Stop #${room.name} being a default channel`
              : `Make #${room.name} a default channel`
          }
          aria-pressed={isDefault}
          className={ICON_BUTTON}
        >
          {isDefault ? (
            <StarOff className="size-4" aria-hidden />
          ) : (
            <Star className="size-4" aria-hidden />
          )}
        </button>
        <button
          type="button"
          onClick={() => setArchiving(room)}
          disabled={busy !== null || channels.length === 1}
          aria-label={`Archive #${room.name}`}
          className={ICON_BUTTON}
        >
          <Archive className="size-4" aria-hidden />
        </button>
      </li>
    );
  };

  const categoryHeader = (category: CategoryChannels, index: number) => {
    const editing = renaming?.id === category.id;
    return (
      <li
        key={`${category.id}-header`}
        className="flex items-center gap-2 bg-grey-light-600 px-2.5 py-1.5 dark:bg-black-primary-bg"
      >
        <FolderPlus
          className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700"
          aria-hidden
        />
        {editing ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <input
              autoFocus
              aria-label={`Name of ${category.name}`}
              value={renaming.name}
              onChange={(event) =>
                setRenaming({ id: category.id, name: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") setRenaming(null);
              }}
              maxLength={60}
              className={cn(FIELD, "h-7 py-0")}
            />
            <button
              type="submit"
              disabled={busy !== null}
              aria-label={`Save name of ${category.name}`}
              className={ICON_BUTTON}
            >
              <Check className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setRenaming(null)}
              aria-label="Cancel renaming"
              className={ICON_BUTTON}
            >
              <X className="size-4" aria-hidden />
            </button>
          </form>
        ) : (
          <>
            <p
              className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-grey-30 dark:text-grey-dark-200"
              title={category.name}
            >
              {category.name}
              <span className="ml-1.5 font-normal normal-case tracking-normal text-grey-60 dark:text-grey-dark-700">
                {category.channels.length} channel
                {category.channels.length === 1 ? "" : "s"}
              </span>
            </p>
            <button
              type="button"
              onClick={() => openCreateChannel(category.id)}
              disabled={busy !== null}
              aria-label={`New channel in ${category.name}`}
              className={ICON_BUTTON}
            >
              <Hash className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() =>
                setRenaming({ id: category.id, name: category.name })
              }
              disabled={busy !== null}
              aria-label={`Rename ${category.name}`}
              className={ICON_BUTTON}
            >
              <Pencil className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() =>
                move(
                  workspace.id,
                  groups.categories,
                  index,
                  -1,
                  "reorder the categories",
                )
              }
              disabled={busy !== null || index === 0}
              aria-label={`Move ${category.name} up`}
              className={ICON_BUTTON}
            >
              <ArrowUp className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() =>
                move(
                  workspace.id,
                  groups.categories,
                  index,
                  1,
                  "reorder the categories",
                )
              }
              disabled={busy !== null || index === groups.categories.length - 1}
              aria-label={`Move ${category.name} down`}
              className={ICON_BUTTON}
            >
              <ArrowDown className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setDeleting(category)}
              disabled={busy !== null}
              aria-label={`Delete ${category.name}`}
              className={ICON_BUTTON}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className={cn(HINT, "mt-0")}>
          Default channels are joined by every new member. Order is what the
          sidebar shows
          {hasCategories ? "; a category groups channels, nothing more" : ""}.
        </p>
        {workspace.canCreateChannels ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="defaultStable"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setNewCategory("")}
              disabled={newCategory !== null}
            >
              <FolderPlus className="size-4" aria-hidden /> New category
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => openCreateChannel(null)}
            >
              <Hash className="size-4" aria-hidden /> New channel
            </Button>
          </div>
        ) : null}
      </div>

      {newCategory !== null ? (
        <form
          className="flex items-center gap-2 rounded-md border border-grey-80 p-2 dark:border-black-300"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNewCategory();
          }}
        >
          <FolderPlus
            className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700"
            aria-hidden
          />
          <input
            autoFocus
            aria-label="Category name"
            placeholder="e.g. Engineering"
            value={newCategory}
            onChange={(event) => setNewCategory(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setNewCategory(null);
            }}
            maxLength={60}
            className={cn(FIELD, "h-8 py-0")}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="h-8 shrink-0"
            disabled={busy !== null || !newCategory.trim()}
            loading={busy === "new-category"}
          >
            Create
          </Button>
          <Button
            type="button"
            variant="defaultStable"
            size="sm"
            className="h-8 shrink-0"
            onClick={() => setNewCategory(null)}
            disabled={busy === "new-category"}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      <ul
        className="divide-y divide-grey-80 rounded-md border border-grey-80 dark:divide-black-300 dark:border-black-300"
        aria-label="Channels"
      >
        {hasCategories && groups.uncategorised.length > 0 ? (
          <li className={GROUP_HEADER}>No category</li>
        ) : null}
        {groups.uncategorised.map((room, index) =>
          channelRow(workspace.id, groups.uncategorised, room, index),
        )}
        {groups.categories.map((category, index) => [
          categoryHeader(category, index),
          ...category.channels.map((room, i) =>
            channelRow(category.id, category.channels, room, i),
          ),
          category.channels.length === 0 ? (
            <li
              key={`${category.id}-empty`}
              className="px-2.5 py-2 text-center text-xs text-grey-60 dark:text-grey-dark-700"
            >
              No channels in {category.name} yet.
            </li>
          ) : null,
        ])}
        {channels.length === 0 && !hasCategories ? (
          <li className="px-2.5 py-3 text-center text-xs text-grey-60 dark:text-grey-dark-700">
            No channels yet.
          </li>
        ) : null}
      </ul>

      <ConfirmationDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        onBack={() => setArchiving(null)}
        onConfirm={() => void archive()}
        heading="Archive channel"
        text={
          archiving
            ? `#${archiving.name} will leave ${workspace.name}. Its history stays with whoever is still in it; nobody new can join.`
            : ""
        }
        button="Archive"
        disableButton={busy !== null}
        icon={<Archive className="size-5 text-white" aria-hidden />}
        iconBgColor={DANGER_ICON_BG}
        confirmVariant="destructive"
      />
      <ConfirmationDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onBack={() => setDeleting(null)}
        onConfirm={() => void removeCategory()}
        heading="Delete category"
        text={
          deleting
            ? deleting.channels.length > 0
              ? `${deleting.name} will be removed. Its ${deleting.channels.length} channel${deleting.channels.length === 1 ? "" : "s"} stay in ${workspace.name}, uncategorised; no message is lost.`
              : `${deleting.name} will be removed. It has no channels.`
            : ""
        }
        button="Delete category"
        disableButton={busy !== null}
        icon={<Trash2 className="size-5 text-white" aria-hidden />}
        iconBgColor={DANGER_ICON_BG}
        confirmVariant="destructive"
      />
    </div>
  );
}

// ----------------------------------------------------------------- danger --

function DangerTab({
  client,
  workspace,
  perms,
  onClose,
}: {
  client: MatrixClient;
  workspace: WorkspaceSummary;
  perms: Perms;
  onClose: () => void;
}) {
  const me = client.getUserId() ?? "";
  const [confirm, setConfirm] = useState<"leave" | "delete" | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const space = client.getRoom(workspace.id);
  // The other owners may not have spoken since we joined, so they are not
  // in the lazy-loaded roster until it is fetched; decide only once it is.
  const roster = useRoomRoster(client, workspace.id);
  const soleOwner =
    roster.loaded &&
    workspace.myRole === "owner" &&
    space !== null &&
    otherOwners(space, me).length === 0 &&
    workspace.memberCount > 1;
  const ownerPending = workspace.myRole === "owner" && !roster.loaded;

  useEffect(() => setTyped(""), [confirm]);

  const leave = async () => {
    if (!space) return;
    setBusy(true);
    try {
      await leaveWorkspace(client, space);
      toast.success(`Left ${workspace.name}`);
      setConfirm(null);
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not leave the workspace",
      );
    } finally {
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (!space || typed !== workspace.name) return;
    setBusy(true);
    try {
      const outcome = await deleteWorkspace(client, space);
      if (outcome.complete) {
        toast.success(`${workspace.name} was deleted`);
      } else {
        // We have left; whatever is listed here survived us. Say it rather
        // than announce a deletion that did not fully happen.
        const roomsLeft = new Set(outcome.membersLeft.map((m) => m.roomId));
        const parts: string[] = [];
        if (roomsLeft.size > 0) {
          const people = new Set(outcome.membersLeft.map((m) => m.userId)).size;
          parts.push(
            `${people} ${people === 1 ? "person is" : "people are"} still in ${channelNames(client, [...roomsLeft])}`,
          );
        }
        if (outcome.unreachable.length > 0)
          parts.push(
            `${channelNames(client, outcome.unreachable)} could not be reached`,
          );
        parts.push(...outcome.problems);
        toast.warning(
          `${workspace.name} was deleted, but: ${parts.join("; ")}.`,
          { duration: 15_000 },
        );
      }
      setConfirm(null);
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not delete the workspace",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-grey-80 p-3 dark:border-black-300">
        <p className="text-sm font-medium text-grey-10 dark:text-grey-light-100">
          Leave {workspace.name}
        </p>
        <p className={HINT}>
          {soleOwner
            ? "You are the only owner. Make someone else an owner in Members before leaving, or delete the workspace."
            : "You leave every channel of this workspace. Someone can invite you back."}
        </p>
        <Button
          variant="defaultStable"
          size="sm"
          className="mt-3 h-9"
          onClick={() => setConfirm("leave")}
          disabled={soleOwner || ownerPending}
          aria-busy={ownerPending && !roster.error}
        >
          Leave workspace
        </Button>
        {roster.error && workspace.myRole === "owner" ? (
          <p
            role="alert"
            className="mt-2 text-xs text-error-50 dark:text-error-50"
          >
            Could not check the other owners: {roster.error}{" "}
            <button
              type="button"
              onClick={roster.retry}
              className="font-medium underline-offset-2 hover:underline"
            >
              Retry
            </button>
          </p>
        ) : null}
      </section>

      {perms.delete && !workspace.isCommunity ? (
        <section className="rounded-md border border-error-50/40 bg-error-50/5 p-3 dark:bg-error-50/10">
          <p className="text-sm font-medium text-error-50 dark:text-error-50">
            Delete {workspace.name}
          </p>
          <p className={HINT}>
            Everyone is removed from the workspace; its channels are closed.
            This cannot be undone.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3 h-9 gap-1.5 text-white"
            onClick={() => setConfirm("delete")}
          >
            <Trash2 className="size-4" aria-hidden /> Delete workspace
          </Button>
        </section>
      ) : null}

      <ConfirmationDialog
        open={confirm === "leave"}
        onClose={() => setConfirm(null)}
        onBack={() => setConfirm(null)}
        onConfirm={() => void leave()}
        heading="Leave workspace"
        text={`You will leave ${workspace.name} and all of its channels.`}
        button="Leave"
        disableButton={busy}
        icon={<Users className="size-5 text-white" aria-hidden />}
        iconBgColor={DANGER_ICON_BG}
        confirmVariant="destructive"
      />
      <ConfirmationDialog
        open={confirm === "delete"}
        onClose={() => setConfirm(null)}
        onBack={() => setConfirm(null)}
        onConfirm={() => void destroy()}
        heading="Delete workspace"
        text={`This removes every member from ${workspace.name} and closes its channels. Type the workspace name to confirm.`}
        button="Delete workspace"
        disableButton={busy || typed !== workspace.name}
        icon={<Trash2 className="size-5 text-white" aria-hidden />}
        iconBgColor={DANGER_ICON_BG}
        confirmVariant="destructive"
        helperText={
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={workspace.name}
            aria-label="Type the workspace name to confirm"
            autoComplete="off"
            className={cn(FIELD, "mt-2")}
          />
        }
      />
    </div>
  );
}

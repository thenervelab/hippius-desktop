"use client";

import { useSetAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Building2, Mail, Plus } from "lucide-react";

import { createWorkspaceOpenAtom, joinWorkspaceOpenAtom } from "@/components/chat/chat-ui-atoms";
import ChatTooltip from "@/components/chat/ChatTooltip";
import WorkspaceAvatar from "@/components/chat/workspaces/WorkspaceAvatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { WorkspaceBadge, WorkspaceInvite, WorkspaceSummary } from "@/lib/chat/spaces";
import { cn } from "@/lib/utils";

interface WorkspaceRailProps {
  client: MatrixClient;
  workspaces: readonly WorkspaceSummary[];
  invites: readonly WorkspaceInvite[];
  badges: ReadonlyMap<string, WorkspaceBadge>;
  activeWorkspaceId: string | null;
  onSelect: (spaceId: string) => void;
  className?: string;
}

/** Whether the mod key of this platform is ⌘ (for the tooltip hint only). */
export function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}

/** The screen-reader label of a rail square: the name, then mentions or unread. */
export function workspaceRailLabel(name: string, badge: WorkspaceBadge): string {
  return [
    name,
    badge.highlight > 0 ? `${badge.highlight} mention${badge.highlight === 1 ? "" : "s"}` : badge.unread > 0 ? `${badge.unread} unread` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The far-left rail, one square per workspace (Slack). The active one is
 * marked with a bar on its left; the badge shows mentions (red) or unread
 * (dot). ⌘1..⌘9 switch; the "+" at the bottom creates or joins. Pending
 * Space invitations show as a mail badge on the "+".
 *
 * Ported from the console's `WorkspaceRail`; the "+" menu uses the app's
 * dropdown primitives instead of the console's table action menu.
 */
export default function WorkspaceRail({ client, workspaces, invites, badges, activeWorkspaceId, onSelect, className }: WorkspaceRailProps) {
  const setCreateOpen = useSetAtom(createWorkspaceOpenAtom);
  const setJoinOpen = useSetAtom(joinWorkspaceOpenAtom);
  const mod = modKeyLabel();
  const inviteWord = `invitation${invites.length === 1 ? "" : "s"}`;

  return (
    <nav
      aria-label="Workspaces"
      className={cn(
        "flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-grey-80 bg-grey-light-500 py-2 dark:border-black-300 dark:bg-black-primary-bg",
        className,
      )}
    >
      <ul className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-1" role="list">
        {workspaces.map((workspace, index) => {
          const badge = badges.get(workspace.id) ?? { unread: 0, highlight: 0 };
          const active = workspace.id === activeWorkspaceId;
          const shortcut = index < 9 ? `${mod}${index + 1}` : null;
          return (
            <li key={workspace.id} className="relative">
              {/* Active bar (Slack): a pill on the rail's left edge. */}
              <span
                aria-hidden
                className={cn(
                  "absolute -left-1 top-1/2 h-0 w-1 -translate-y-1/2 rounded-r bg-grey-10 transition-all dark:bg-grey-light-100",
                  active && "h-8",
                )}
              />
              <ChatTooltip tooltipContent={shortcut ? `${workspace.name} · ${shortcut}` : workspace.name} side="right">
                <button
                  type="button"
                  onClick={() => onSelect(workspace.id)}
                  aria-label={workspaceRailLabel(workspace.name, badge)}
                  aria-current={active ? "true" : undefined}
                  aria-keyshortcuts={shortcut ? `${mod === "⌘" ? "Meta" : "Control"}+${index + 1}` : undefined}
                  className={cn(
                    "group relative flex size-11 items-center justify-center rounded-xl outline-none transition-[border-radius,opacity] focus-visible:ring-2 focus-visible:ring-primary-50 dark:focus-visible:ring-primary-40",
                    active ? "opacity-100" : "opacity-70 hover:opacity-100",
                  )}
                >
                  <WorkspaceAvatar
                    client={client}
                    name={workspace.name}
                    avatarMxc={workspace.avatarMxc}
                    size={36}
                    className={cn("transition-[border-radius]", active ? "rounded-lg" : "rounded-xl group-hover:rounded-lg")}
                  />
                  {badge.highlight > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-error-50 px-1 text-[10px] font-semibold text-white ring-2 ring-grey-light-500 dark:bg-error-40 dark:ring-black-primary-bg">
                      {badge.highlight > 99 ? "99+" : badge.highlight}
                    </span>
                  ) : badge.unread > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full bg-grey-10 ring-2 ring-grey-light-500 dark:bg-grey-light-100 dark:ring-black-primary-bg" />
                  ) : null}
                </button>
              </ChatTooltip>
            </li>
          );
        })}
      </ul>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={invites.length > 0 ? `Add a workspace, ${invites.length} pending ${inviteWord}` : "Add a workspace"}
            title="Create or join a workspace"
            className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-grey-90 text-grey-40 outline-none transition-colors hover:bg-grey-80 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:bg-black-300 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
          >
            <Plus className="size-5" aria-hidden />
            {invites.length > 0 ? (
              <span className="pointer-events-none absolute -right-0.5 -top-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary-50 px-1 text-[10px] font-semibold text-white ring-2 ring-grey-light-500 dark:bg-primary-40 dark:ring-black-primary-bg">
                {invites.length}
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" aria-label="Add a workspace">
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <Building2 className="mr-2 size-4" aria-hidden />
            Create a workspace
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setJoinOpen(true)}>
            <Mail className="mr-2 size-4" aria-hidden />
            {invites.length > 0 ? `Join a workspace (${invites.length} ${inviteWord})` : "Join a workspace"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}

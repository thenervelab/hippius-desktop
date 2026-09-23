"use client";

import { useSetAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Building2, Mail, MessageSquare } from "lucide-react";

import { rightPanelAtom, selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import CreateWorkspaceForm from "@/components/chat/workspaces/CreateWorkspaceForm";
import JoinWorkspaceList from "@/components/chat/workspaces/JoinWorkspaceList";

/**
 * Ported from the console's `WorkspaceOnboarding`.
 *
 * What the chat shows to someone who belongs to no workspace yet: create
 * one, or join one (an invitation, or the public Hippius community). Two
 * cards side by side on a wide screen, stacked below.
 */
export default function WorkspaceOnboarding({
  client,
  workspaces,
  onOpenConversations,
}: {
  client: MatrixClient;
  workspaces: WorkspacesState;
  /**
   * Set when the person already has conversations (direct messages, channels
   * outside any workspace) that this pane is standing in front of and the
   * sidebar is not on screen: a way to reach them without first creating or
   * joining a workspace.
   */
  onOpenConversations?: () => void;
}) {
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const land = (spaceId: string, roomId: string | null) => {
    workspaces.setActiveWorkspaceId(spaceId);
    setSelectedRoomId(roomId);
    setRightPanel(null);
  };
  const invites = workspaces.invites.length;

  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto p-6" data-testid="workspace-onboarding">
      <div className="w-full max-w-4xl">
        <header className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-grey-10 dark:text-grey-light-100">Welcome to Hippius Chat</h1>
          <p className="mt-1 text-sm text-grey-60 dark:text-grey-dark-700">
            A workspace is where your team talks. Create your own, or join one you were invited to.
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          <section
            aria-labelledby="onboarding-create-title"
            className="rounded-2xl border border-grey-80 bg-white p-5 shadow-sm dark:border-black-300 dark:bg-black-300"
          >
            <div className="mb-4 flex items-center gap-2.5">
              <span className="inline-flex size-9 items-center justify-center rounded-lg bg-primary-50 text-white dark:bg-primary-40">
                <Building2 className="size-[18px]" aria-hidden />
              </span>
              <div>
                <h2 id="onboarding-create-title" className="text-base font-semibold text-grey-10 dark:text-grey-light-100">
                  Create a workspace
                </h2>
                <p className="text-xs text-grey-60 dark:text-grey-dark-700">For your company or team. You become its owner.</p>
              </div>
            </div>
            <CreateWorkspaceForm
              client={client}
              idPrefix="onboarding-workspace"
              onCreated={({ spaceId, channelIds }) => land(spaceId, channelIds[0] ?? null)}
            />
          </section>

          <section
            aria-labelledby="onboarding-join-title"
            className="rounded-2xl border border-grey-80 bg-white p-5 shadow-sm dark:border-black-300 dark:bg-black-300"
          >
            <div className="mb-4 flex items-center gap-2.5">
              <span className="relative inline-flex size-9 items-center justify-center rounded-lg bg-grey-90 text-grey-10 dark:bg-black-500 dark:text-grey-light-100">
                <Mail className="size-[18px]" aria-hidden />
                {invites > 0 ? (
                  <span className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary-50 px-1 text-[10px] font-semibold text-white dark:bg-primary-40">
                    {invites}
                  </span>
                ) : null}
              </span>
              <div>
                <h2 id="onboarding-join-title" className="text-base font-semibold text-grey-10 dark:text-grey-light-100">
                  Join a workspace
                </h2>
                <p className="text-xs text-grey-60 dark:text-grey-dark-700">
                  {invites > 0 ? `You have ${invites} pending invitation${invites === 1 ? "" : "s"}.` : "Accept an invitation, or explore the community."}
                </p>
              </div>
            </div>
            <JoinWorkspaceList
              client={client}
              invites={workspaces.invites}
              inCommunity={false}
              onJoined={(spaceId) => land(spaceId, null)}
            />
          </section>
        </div>

        {onOpenConversations ? (
          <p className="mt-6 text-center text-sm text-grey-60 dark:text-grey-dark-700">
            Not now?{" "}
            <button
              type="button"
              onClick={onOpenConversations}
              className="inline-flex items-center gap-1 font-medium text-primary-50 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-primary-40 dark:focus-visible:ring-primary-40"
            >
              <MessageSquare className="size-3.5" aria-hidden />
              Open your conversations
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}

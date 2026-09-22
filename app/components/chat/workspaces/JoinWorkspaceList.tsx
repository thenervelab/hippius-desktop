"use client";

import { type FormEvent, useState } from "react";
import { useAtomValue } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Check, Globe, Link2, X } from "lucide-react";
import { toast } from "sonner";

import { chatCommunitySpaceAliasAtom } from "@/components/chat/chat-ui-atoms";
import WorkspaceAvatar from "@/components/chat/workspaces/WorkspaceAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { redeemFailureMessage, redeemInviteLink } from "@/lib/chat/invite-links";
import { type WorkspaceInvite, acceptWorkspaceInvite, joinCommunity } from "@/lib/chat/spaces";
import { cn } from "@/lib/utils";

interface JoinWorkspaceListProps {
  client: MatrixClient;
  invites: readonly WorkspaceInvite[];
  /** Already a member of the community Space: hide that card. */
  inCommunity: boolean;
  onJoined: (spaceId: string) => void;
  className?: string;
}

/**
 * Pending Space invitations (accept joins the Space and its default
 * channels; decline leaves), a field to paste an invite link into, and the
 * always-available Hippius community.
 *
 * Ported from the console; the community alias is the Rust-provided one.
 * The paste field is the desktop's stand-in for the console's
 * `/chat/join/<token>` page: the app has no URL routes, so a link someone
 * sent is redeemed here (`redeemInviteLink`, Rust does the backend half).
 */
export default function JoinWorkspaceList({ client, invites, inCommunity, onJoined, className }: JoinWorkspaceListProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const communitySpaceAlias = useAtomValue(chatCommunitySpaceAliasAtom);

  const redeemLink = async (event: FormEvent) => {
    event.preventDefault();
    const input = linkInput.trim();
    if (!input || busy !== null) return;
    setBusy("link");
    setLinkError(null);
    try {
      const result = await redeemInviteLink(client, input);
      if (result.kind === "joined") {
        toast.success("Joined the workspace");
        setLinkInput("");
        onJoined(result.spaceId);
      } else {
        setLinkError(redeemFailureMessage(result));
      }
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : "Could not use the invitation link");
    } finally {
      setBusy(null);
    }
  };

  const respond = async (invite: WorkspaceInvite, accept: boolean) => {
    setBusy(invite.id);
    try {
      if (accept) {
        await acceptWorkspaceInvite(client, invite.id);
        toast.success(`Joined ${invite.name}`);
        onJoined(invite.id);
      } else {
        await client.leave(invite.id);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not respond to the invitation");
    } finally {
      setBusy(null);
    }
  };

  const browseCommunity = async () => {
    setBusy("community");
    try {
      const spaceId = await joinCommunity(client, communitySpaceAlias);
      toast.success("Welcome to the Hippius community");
      onJoined(spaceId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not join the community");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn("flex flex-col gap-3 font-geist", className)}>
      <div>
        <p className="text-sm font-medium leading-5 text-grey-dark-800 dark:text-grey-dark-200">Invitations</p>
        {invites.length === 0 ? (
          <p className="mt-1.5 rounded-[10px] border border-dashed border-grey-80 px-3 py-3 text-xs text-grey-60 dark:border-black-300 dark:text-grey-dark-700">
            No pending invitations. Ask a workspace admin to invite you by handle or send you a link.
          </p>
        ) : (
          <ul className="mt-1.5 flex max-h-80 flex-col gap-1.5 overflow-y-auto" aria-label="Workspace invitations">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="flex items-center gap-2.5 rounded-[10px] border border-grey-80 bg-grey-light-600 px-3 py-2 dark:border-black-300 dark:bg-black-primary-bg"
              >
                <WorkspaceAvatar client={client} name={invite.name} avatarMxc={invite.avatarMxc} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-grey-10 dark:text-grey-light-100" title={invite.name}>{invite.name}</p>
                  {invite.inviterId ? (
                    <p className="truncate text-[11px] text-grey-60 dark:text-grey-dark-700">
                      Invited by {client.getUser(invite.inviterId)?.displayName ?? invite.inviterId}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="h-8 gap-1 px-2.5 text-xs"
                  loading={busy === invite.id}
                  disabled={busy !== null && busy !== invite.id}
                  onClick={() => respond(invite, true)}
                  aria-label={`Accept invitation to ${invite.name}`}
                >
                  <Check className="size-3.5" aria-hidden /> Join
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-grey-60 dark:text-grey-dark-700"
                  disabled={busy !== null}
                  onClick={() => respond(invite, false)}
                  aria-label={`Decline invitation to ${invite.name}`}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={redeemLink} aria-label="Join with an invite link">
        <label htmlFor="chat-join-invite-link" className="text-sm font-medium leading-5 text-grey-dark-800 dark:text-grey-dark-200">
          Have an invite link?
        </label>
        <div className="mt-1.5 flex items-center gap-2">
          <Input
            id="chat-join-invite-link"
            value={linkInput}
            onChange={(e) => {
              setLinkInput(e.target.value);
              setLinkError(null);
            }}
            placeholder="Paste the link or its code"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={linkError ? true : undefined}
            aria-describedby={linkError ? "chat-join-invite-link-error" : undefined}
            wrapperClassName="min-h-10 flex-1 items-center"
            className="text-xs"
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="h-10 gap-1 px-3 text-xs"
            loading={busy === "link"}
            disabled={busy !== null || !linkInput.trim()}
          >
            <Link2 className="size-3.5" aria-hidden /> Join
          </Button>
        </div>
        {linkError ? (
          <p id="chat-join-invite-link-error" role="alert" className="mt-1.5 text-xs text-error-50 dark:text-error-40">
            {linkError}
          </p>
        ) : null}
      </form>

      {!inCommunity ? (
        <div>
          <p className="text-sm font-medium leading-5 text-grey-dark-800 dark:text-grey-dark-200">Public</p>
          <button
            type="button"
            onClick={browseCommunity}
            disabled={busy !== null || !communitySpaceAlias}
            className="mt-1.5 flex w-full items-center gap-2.5 rounded-[10px] border border-grey-80 bg-white px-3 py-2.5 text-left outline-none transition-colors hover:border-grey-70 hover:bg-grey-light-600 focus-visible:ring-2 focus-visible:ring-primary-50 disabled:opacity-60 dark:border-black-300 dark:bg-black-300 dark:hover:border-grey-dark-500 dark:hover:bg-black-500 dark:focus-visible:ring-primary-40"
            aria-busy={busy === "community"}
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-50/10 text-primary-50 dark:bg-primary-40/15 dark:text-primary-40">
              <Globe className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-grey-10 dark:text-grey-light-100">Browse the Hippius community</span>
              <span className="block text-[11px] text-grey-60 dark:text-grey-dark-700">
                Open to everyone on Hippius: announcements, support, and the people building here.
              </span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

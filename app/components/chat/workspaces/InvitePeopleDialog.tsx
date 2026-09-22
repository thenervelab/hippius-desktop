"use client";

import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Check, Copy, Link2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";

import { chatServerNameAtom, invitePeopleOpenAtom } from "@/components/chat/chat-ui-atoms";
import {
  dialogContentClassName,
  dialogHintClassName,
  dialogLabelClassName,
  dialogPrimaryButtonClassName,
  dialogSecondaryButtonClassName,
  dialogTitleClassName,
} from "@/components/chat/dialog-styles";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import UserAvatar from "@/components/chat/UserAvatar";
import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
import { Input } from "@/components/ui/input";
import { isValidUserId, knownUsers, normaliseUserId } from "@/lib/chat/rooms";
import { type DirectoryUser, defaultChannelIds, inviteToWorkspace, searchPeople } from "@/lib/chat/spaces";
import { chatCreateWorkspaceInvite, type WorkspaceInviteLink } from "@/lib/tauri/chat";
import { cn } from "@/lib/utils";

/**
 * Whether the invite-link feature has been seen to be absent this session.
 * Module-level so the dialog does not probe the backend on every open.
 */
let inviteLinksUnavailable = false;

/**
 * "Invite people to <workspace>": pick people by handle (directory search
 * plus everyone you already share a room with, plus a typed id), or copy
 * an invite link minted by the backend. Invitees get the Space and its
 * default channels. Only admins and owners can invite.
 *
 * Ported from the console. The link is minted through Rust
 * (`chatCreateWorkspaceInvite`) — it needs the Hippius API token the
 * webview never holds — and comes back as a `kind`-tagged outcome, so the
 * "not an admin" and "backend has no such endpoint" cases are branched on
 * here without parsing an error.
 */
export default function InvitePeopleDialog({ client, workspaces }: { client: MatrixClient; workspaces: WorkspacesState }) {
  const [open, setOpen] = useAtom(invitePeopleOpenAtom);
  const serverName = useAtomValue(chatServerNameAtom);
  const active = workspaces.active;

  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<DirectoryUser[]>([]);
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [link, setLink] = useState<WorkspaceInviteLink | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkUnavailable, setLinkUnavailable] = useState(inviteLinksUnavailable);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery("");
      setPicked([]);
      setResults([]);
      setHighlight(0);
      setLink(null);
      setCopied(false);
    }
  }, [open]);

  // Directory search, debounced; people we already know answer instantly.
  const known = useMemo(() => (open ? knownUsers(client) : []), [client, open]);
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      searchPeople(client, q, 8)
        .then((found) => {
          if (!cancelled) setResults(found);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [client, open, query]);

  const me = client.getUserId();
  const spaceMembers = useMemo(() => {
    if (!active) return new Set<string>();
    const room = client.getRoom(active.id);
    return new Set(room?.getJoinedMembers().map((m) => m.userId) ?? []);
  }, [client, active]);

  const q = query.trim().toLowerCase().replace(/^@/, "");
  const options = useMemo(() => {
    const seen = new Set(picked.map((p) => p.userId));
    const out: DirectoryUser[] = [];
    const push = (u: DirectoryUser) => {
      if (u.userId === me || seen.has(u.userId) || spaceMembers.has(u.userId)) return;
      seen.add(u.userId);
      out.push(u);
    };
    if (q) {
      known.filter((u) => u.displayName.toLowerCase().includes(q) || u.userId.toLowerCase().includes(q)).forEach(push);
      results.forEach(push);
      // An empty server name means the Rust config has not landed: never
      // treat "" as a domain (`chatServerNameAtom`).
      if (serverName) {
        const typed = normaliseUserId(query, serverName);
        if (isValidUserId(typed)) push({ userId: typed, displayName: typed, avatarMxc: null });
      }
    }
    return out.slice(0, 8);
  }, [known, results, q, query, picked, me, spaceMembers, serverName]);

  const pick = (user: DirectoryUser) => {
    setPicked((list) => (list.some((p) => p.userId === user.userId) ? list : [...list, user]));
    setQuery("");
    setHighlight(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, Math.max(options.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === "Enter" && options[highlight]) {
      event.preventDefault();
      pick(options[highlight]);
    } else if (event.key === "Backspace" && !query && picked.length > 0) {
      setPicked((list) => list.slice(0, -1));
    }
  };

  const close = () => {
    if (submitting) return;
    setOpen(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!active || picked.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const space = client.getRoom(active.id);
      const channels = space ? defaultChannelIds(client, space) : [];
      const { invited, failed } = await inviteToWorkspace(
        client,
        active.id,
        picked.map((p) => p.userId),
        channels,
      );
      if (invited.length > 0) toast.success(`Invited ${invited.length} ${invited.length === 1 ? "person" : "people"} to ${active.name}`);
      if (failed.length > 0) {
        toast.error(`Could not invite ${failed.map((f) => f.userId).join(", ")}: ${failed[0].message}`);
        setPicked((list) => list.filter((p) => failed.some((f) => f.userId === p.userId)));
      } else {
        setOpen(false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the invitations");
    } finally {
      setSubmitting(false);
    }
  };

  const mintLink = async () => {
    if (!active) return;
    setLinkBusy(true);
    try {
      const outcome = await chatCreateWorkspaceInvite(active.id);
      switch (outcome.kind) {
        case "link":
          setLink(outcome);
          break;
        case "unavailable":
          inviteLinksUnavailable = true;
          setLinkUnavailable(true);
          break;
        case "forbidden":
          toast.error("Only workspace admins and owners can create invite links.");
          break;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the invite link");
    } finally {
      setLinkBusy(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy the link");
    }
  };

  const canInvite = active !== null && active.myRole !== "member";
  const listId = "chat-invite-people-options";

  return (
    <FramedDialog
      open={open && active !== null}
      onClose={close}
      title={active ? <span title={active.name}>Invite people to {active.name}</span> : "Invite people"}
      icon={<UserPlus className="size-[17px] text-white" aria-hidden />}
      maxWidth="max-w-[640px]"
      contentClassName={dialogContentClassName}
      titleClassName={dialogTitleClassName}
    >
      {!canInvite ? (
        <p className="mt-4 text-sm text-grey-60 dark:text-grey-dark-700">Only workspace admins and owners can invite people.</p>
      ) : (
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4 font-geist">
          <div>
            <label htmlFor="chat-invite-people-query" className={dialogLabelClassName}>
              By handle
            </label>
            {/* `relative` so the suggestion list can drop over the section below
                instead of pushing it down: the dialog keeps its height while typing. */}
            <div className="relative">
              <div className="mt-1.5 flex min-h-12 flex-wrap items-center gap-1.5 rounded-md border border-grey-80 bg-white px-2 py-1.5 focus-within:ring-2 focus-within:ring-primary-50 dark:border-black-300 dark:bg-black-300 dark:focus-within:ring-primary-40">
                {picked.map((user) => (
                  <span
                    key={user.userId}
                    className="inline-flex h-7 items-center gap-1 rounded-md bg-grey-90 pl-1 pr-1 text-xs font-medium text-grey-10 dark:bg-black-500 dark:text-grey-light-100"
                  >
                    <UserAvatar client={client} seed={user.userId} avatarMxc={user.avatarMxc} size={18} alt="" />
                    <span className="max-w-36 truncate" title={user.displayName}>
                      {user.displayName}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPicked((list) => list.filter((p) => p.userId !== user.userId))}
                      aria-label={`Remove ${user.displayName}`}
                      className="inline-flex size-4 items-center justify-center rounded text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </span>
                ))}
                <Input
                  id="chat-invite-people-query"
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHighlight(0);
                  }}
                  onKeyDown={onKeyDown}
                  placeholder={picked.length === 0 ? "Name or @handle" : "Add another…"}
                  role="combobox"
                  aria-expanded={options.length > 0}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={options[highlight] ? `${listId}-${highlight}` : undefined}
                  wrapperClassName="min-h-8 min-w-36 flex-1 border-0 bg-transparent px-1 shadow-none focus-within:ring-0 dark:bg-transparent"
                  className="h-8 text-sm"
                />
              </div>
              {options.length > 0 ? (
                <ul
                  id={listId}
                  role="listbox"
                  className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-grey-80 bg-white py-1 shadow-lg dark:border-black-300 dark:bg-black-300"
                >
                  {options.map((user, index) => (
                    <li
                      key={user.userId}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === highlight}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(user)}
                      onMouseEnter={() => setHighlight(index)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm",
                        index === highlight ? "bg-grey-90 dark:bg-black-500" : "",
                      )}
                    >
                      <UserAvatar client={client} seed={user.userId} avatarMxc={user.avatarMxc} size={24} alt="" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-grey-10 dark:text-grey-light-100" title={user.displayName}>
                          {user.displayName}
                        </span>
                        {user.displayName !== user.userId ? (
                          <span className="block truncate text-[11px] text-grey-60 dark:text-grey-dark-700">{user.userId}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <p className={dialogHintClassName}>They will be invited to {active?.name} and its default channels. Use ↑↓ and Enter to pick.</p>
          </div>

          <div>
            <p className={dialogLabelClassName}>Invite link</p>
            {linkUnavailable ? (
              <div className="mt-1.5 flex items-center gap-2 rounded-md border border-dashed border-grey-80 px-3 py-2.5 text-xs text-grey-60 dark:border-black-300 dark:text-grey-dark-700">
                <Link2 className="size-4 shrink-0" aria-hidden />
                Invite links are not available yet
              </div>
            ) : link ? (
              <div className="mt-1.5 flex items-center gap-2">
                <Input
                  readOnly
                  value={link.url}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Invite link"
                  wrapperClassName="min-h-10 flex-1 items-center"
                  className="text-xs"
                />
                <Button type="button" variant="primaryLight" size="sm" className="h-10 gap-1.5 px-3" onClick={copyLink} aria-label="Copy invite link">
                  {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            ) : (
              <Button type="button" variant="primaryLight" size="sm" className="mt-1.5 h-10 w-full gap-2" onClick={mintLink} loading={linkBusy} disabled={linkBusy}>
                <Link2 className="size-4" aria-hidden /> Create an invite link
              </Button>
            )}
            <p className={dialogHintClassName}>
              {link
                ? `Anyone with the link can join until ${new Date(link.expires_at).toLocaleDateString()}. Paste it into "Join a workspace" in the app, or open it in the web console.`
                : "A link anyone can use to join, valid 7 days."}
            </p>
          </div>

          <div className="space-y-3 pt-1">
            <Button
              type="submit"
              variant="primary"
              size="auto"
              className={dialogPrimaryButtonClassName}
              disabled={picked.length === 0 || submitting}
              loading={submitting}
            >
              {picked.length > 1 ? `Send ${picked.length} invitations` : "Send invitation"}
            </Button>
            <Button type="button" size="auto" onClick={close} disabled={submitting} className={dialogSecondaryButtonClassName}>
              {link ? "Done" : "Cancel"}
            </Button>
          </div>
        </form>
      )}
    </FramedDialog>
  );
}

"use client";

// "General access": an invite link anybody holding it can use (a drive), or
// a single-use link for one person (a folder). It only ever calls the link
// commands, and a folder target only ever calls `create_folder_invite`: the
// folder's PRESENCE decides, so an empty folder path is refused by Rust
// rather than quietly becoming a whole-drive invite.
//
// After a mint it shows the link (key hidden), what it grants from what Rust
// actually sent, and ways to make another or revoke this one.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, Globe, Link2 } from "lucide-react";
import { Button, Icons } from "@/components/ui";
import { Select } from "@/components/ui/select/Select";
import { cn } from "@/lib/utils";
import {
  createDriveInvite,
  createFolderInvite,
  revokeDriveInvite,
  type DriveInviteLink,
  type DriveTarget,
} from "@/app/lib/tauri/sharedDrives";
import { DRIVE_ROLES, driveRoleDescription, driveRoleLabel, type DriveRole } from "@/app/lib/shared-drives/roles";
import { truncateInviteUrl } from "@/app/lib/shared-drives/inviteLink";
import { errorMessage } from "@/lib/utils/errorUtils";
import {
  DEFAULT_INVITE_TTL_SECS,
  FOLDER_INVITE_ROLES,
  FOLDER_INVITE_TTL_OPTIONS,
  NEVER_EXPIRES_SECS,
  clampInviteTtl,
  inviteTtlOptionsFor,
} from "../shareDriveModalState";
import { InlineNotice } from "./InlineNotice";
import { SectionNoticeView } from "./SectionNoticeView";
import {
  describeCreatedLink,
  generalAccessNote,
  noticeForError,
  type SectionNotice,
} from "./shareDialogState";

const COPIED_MS = 2000;
const TEXT_ACTION = "text-xs font-medium hover:underline";

export function GeneralAccessSection({
  label,
  pathPrefix,
  folderRoles,
  target,
  onCreated,
  onUpgrade,
}: {
  label: string;
  /** Present for a folder: the link then goes through the folder command. */
  pathPrefix: string | null;
  /** Folder collaboration is on: a folder link may be Viewer or Editor. */
  folderRoles: boolean;
  target?: DriveTarget;
  /** A link was made or revoked: badges and the Links tab refresh. */
  onCreated: () => void;
  onUpgrade: () => void;
}) {
  const folder = pathPrefix !== null;
  // `writer` is what every drive link before the picker minted; a folder
  // starts at Viewer.
  const [role, setRole] = useState<DriveRole>(folder ? "reader" : "writer");
  const [ttlSecs, setTtlSecs] = useState(DEFAULT_INVITE_TTL_SECS);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<SectionNotice | null>(null);
  const [created, setCreated] = useState<DriveInviteLink | null>(null);
  const [revoked, setRevoked] = useState(false);

  const roleOptions: readonly DriveRole[] = folder
    ? folderRoles
      ? FOLDER_INVITE_ROLES
      : ["reader"]
    : DRIVE_ROLES;
  const ttlOptions = folder ? FOLDER_INVITE_TTL_OPTIONS : inviteTtlOptionsFor(role);

  const mint = useCallback(
    async (asRole: DriveRole) => {
      if (running) return;
      setRunning(true);
      setNotice(null);
      setRevoked(false);
      try {
        const link = folder
          ? // One person, one folder, at most 30 days. Never the drive command.
            await createFolderInvite(label, pathPrefix ?? "", {
              expiresInSecs: ttlSecs,
              role: asRole === "writer" ? "writer" : "reader",
              target,
            })
          : // Rust applies the defaults and the manager caps.
            await createDriveInvite(label, { expiresInSecs: ttlSecs, role: asRole, target });
        setCreated(link);
        onCreated();
      } catch (err) {
        setNotice(noticeForError(err));
      } finally {
        setRunning(false);
      }
    },
    [running, folder, label, pathPrefix, ttlSecs, target, onCreated],
  );

  const mintAsViewer = useCallback(() => {
    setRole("reader");
    void mint("reader");
  }, [mint]);

  const revoke = useCallback(async () => {
    if (!created || running) return;
    setRunning(true);
    setNotice(null);
    try {
      await revokeDriveInvite(label, created.inviteId, target);
      setCreated(null);
      setRevoked(true);
      onCreated();
    } catch (err) {
      setNotice({ kind: "error", message: errorMessage(err) });
    } finally {
      setRunning(false);
    }
  }, [created, running, label, target, onCreated]);

  const handleRoleChange = useCallback(
    (next: DriveRole) => {
      setRole(next);
      setNotice((n) => (n?.kind === "folderEditor" ? null : n));
      // Picking Manager with a wider lifetime selected must move the
      // selection to 24 hours, not leave one on screen Rust would cap.
      if (!folder) setTtlSecs((secs) => clampInviteTtl(next, secs));
    },
    [folder],
  );

  return (
    <section aria-labelledby="share-general-access">
      <h3 id="share-general-access" className="mb-2 text-sm font-medium text-grey-10 dark:text-white">
        General access
      </h3>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full",
            created
              ? "bg-success-100 text-success-40 dark:bg-success-50/15 dark:text-success-50"
              : "bg-grey-90 text-grey-50 dark:bg-white/10 dark:text-grey-dark-600",
          )}
        >
          {created ? <Globe className="size-[18px]" /> : <Link2 className="size-[18px]" />}
        </span>

        <div className="@container grid min-w-0 flex-1 gap-2.5">
          {created ? (
            <CreatedLink
              link={created}
              folder={folder}
              busy={running}
              onAnother={() => setCreated(null)}
              onRevoke={() => void revoke()}
            />
          ) : (
            <>
              <div>
                <p className="text-sm font-medium text-grey-10 dark:text-white">
                  {folder ? "Invite link for one person" : "Invite link"}
                </p>
                <p className="text-xs text-grey-50 dark:text-grey-dark-600">
                  {generalAccessNote({ folder, role, neverExpires: ttlSecs === NEVER_EXPIRES_SECS })}
                </p>
              </div>
              {/* One row of compact controls, the button the same height;
                  stacked full width when the dialog is narrow. */}
              <div className="flex flex-col gap-2 @sm:flex-row @sm:items-center">
                <div className="flex gap-2 @sm:contents">
                  <Select
                    ariaLabel="Link access"
                    value={role}
                    onValueChange={(value) => handleRoleChange(value as DriveRole)}
                    options={roleOptions.map((r) => ({
                      label: driveRoleLabel(r),
                      value: r,
                      description: driveRoleDescription(r),
                    }))}
                    size="compact"
                    minimal
                    className="min-w-0 flex-1 @sm:w-[104px] @sm:flex-none"
                  />
                  <Select
                    ariaLabel="Link expires"
                    value={String(ttlSecs)}
                    onValueChange={(value) => setTtlSecs(Number(value))}
                    options={ttlOptions.map(({ label: text, secs }) => ({ label: text, value: String(secs) }))}
                    size="compact"
                    minimal
                    className="min-w-0 flex-1 @sm:w-[132px] @sm:flex-none"
                  />
                </div>
                <Button
                  type="button"
                  variant="primary"
                  size="auto"
                  disabled={running}
                  onClick={() => void mint(role)}
                  className="h-[34px] w-full shrink-0 gap-1.5 rounded-[8px] px-3.5 text-[13px] font-medium @sm:ml-auto @sm:w-auto"
                >
                  <Icons.Link className="size-3.5" />
                  {running ? "Creating link…" : "Create link"}
                </Button>
              </div>
            </>
          )}

          {revoked ? (
            <InlineNotice tone="success">That link was revoked and no longer works.</InlineNotice>
          ) : null}
          {notice ? (
            <SectionNoticeView
              notice={notice}
              viewOnlyLabel="Create as view only"
              onViewOnly={mintAsViewer}
              onUpgrade={onUpgrade}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The finished link: truncated with the `#k=` key hidden (the fragment is
 * the drive or folder key and must not appear on screen), a Copy that
 * writes the FULL URL, what the link grants, and what can be done next.
 */
function CreatedLink({
  link,
  folder,
  busy,
  onAnother,
  onRevoke,
}: {
  link: DriveInviteLink;
  folder: boolean;
  busy: boolean;
  onAnother: () => void;
  onRevoke: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.inviteUrl);
      setCopyFailed(false);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <>
      <div>
        <p className="text-sm font-medium text-grey-10 dark:text-white">Anyone with the link</p>
        <p className="text-xs text-grey-50 dark:text-grey-dark-600">
          {folder
            ? "Works once, for the first person who opens it."
            : "Anyone with the link can join until it expires."}
        </p>
      </div>
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-[8px] border py-1.5 pl-3 pr-1.5",
          "border-grey-80 bg-white dark:border-[#494949] dark:bg-[#1f1f1f]",
        )}
      >
        <p
          className="min-w-0 flex-1 truncate font-mono text-xs text-grey-10 dark:text-grey-dark-800"
          title="Invite link (key hidden)"
        >
          {truncateInviteUrl(link.inviteUrl)}
        </p>
        <Button
          type="button"
          variant="primary"
          size="auto"
          aria-label={copied ? "Copied" : "Copy link"}
          onClick={() => void copy()}
          className="h-[32px] shrink-0 gap-1.5 rounded-[6px] px-3 text-xs font-medium"
        >
          {copied ? <Check className="size-3.5" /> : <Icons.Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-grey-50 dark:text-grey-dark-600">{describeCreatedLink(link)}</p>
      {copyFailed ? <p className="text-xs text-error-70">Could not copy the link. Try again.</p> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={onAnother}
          disabled={busy}
          className={cn(TEXT_ACTION, "text-primary-50 dark:text-primary-brand-dark")}
        >
          Create another link
        </button>
        <button
          type="button"
          onClick={onRevoke}
          disabled={busy}
          className={cn(TEXT_ACTION, "text-grey-50 hover:text-error-70 dark:text-grey-dark-600")}
        >
          {busy ? "Revoking…" : "Revoke"}
        </button>
      </div>
    </>
  );
}

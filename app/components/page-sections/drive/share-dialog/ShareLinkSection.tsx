"use client";

// "Share a link": who the link makes them, how long it lasts, one button.
// It only ever calls the link commands (`POST /v1/drive-invites`), and a
// folder target only ever calls `create_folder_invite`: the folder's PRESENCE
// decides, so an empty folder path is refused by Rust rather than quietly
// becoming a whole-drive invite.
//
// After a mint the same section shows the link, what it grants and for how
// long (from what Rust actually sent), and a way to make another.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Button, Icons } from "@/components/ui";
import { Select } from "@/components/ui/select/Select";
import { cn } from "@/lib/utils";
import {
  createDriveInvite,
  createFolderInvite,
  type DriveInviteLink,
  type DriveTarget,
} from "@/app/lib/tauri/sharedDrives";
import { DRIVE_ROLES, driveRoleLabel, type DriveRole } from "@/app/lib/shared-drives/roles";
import { truncateInviteUrl } from "@/app/lib/shared-drives/inviteLink";
import {
  DEFAULT_INVITE_TTL_SECS,
  FOLDER_INVITE_ROLES,
  FOLDER_INVITE_TTL_OPTIONS,
  NEVER_EXPIRES_SECS,
  clampInviteTtl,
  inviteTtlOptionsFor,
} from "../shareDriveModalState";
import { SectionNoticeView } from "./SectionNoticeView";
import {
  describeCreatedLink,
  linkWarning,
  noticeForError,
  type SectionNotice,
} from "./shareDialogState";

const COPIED_MS = 2000;

export function ShareLinkSection({
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

  const handleRoleChange = useCallback(
    (next: DriveRole) => {
      setRole(next);
      setNotice((n) => (n?.kind === "folderEditor" ? null : n));
      // Picking Manager with a wider lifetime selected must move the
      // selection, not leave one on screen that Rust would quietly cap.
      if (!folder) setTtlSecs((secs) => clampInviteTtl(next, secs));
    },
    [folder],
  );

  const noticeView = notice ? (
    <SectionNoticeView
      notice={notice}
      viewOnlyLabel="Create as view only"
      onViewOnly={mintAsViewer}
      onUpgrade={onUpgrade}
      className="mt-3"
    />
  ) : null;

  return (
    <section aria-labelledby="share-link-heading" className="@container">
      <h3 id="share-link-heading" className="mb-2 text-sm font-medium text-grey-10 dark:text-white">
        Share a link
      </h3>

      {created ? (
        <CreatedLink link={created} onAnother={() => setCreated(null)} />
      ) : (
        <>
          <div className="flex flex-col gap-2 @sm:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs text-grey-50 dark:text-grey-dark-600">Access</span>
              <Select
                ariaLabel="Link access"
                value={role}
                onValueChange={(value) => handleRoleChange(value as DriveRole)}
                options={roleOptions.map((r) => ({ label: driveRoleLabel(r), value: r }))}
                triggerClassName="min-h-[44px] py-2.5 sm:min-h-[44px] px-3"
                valueClassName="text-sm"
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs text-grey-50 dark:text-grey-dark-600">Expires</span>
              <Select
                ariaLabel="Link expires"
                value={String(ttlSecs)}
                onValueChange={(value) => setTtlSecs(Number(value))}
                options={ttlOptions.map(({ label: text, secs }) => ({ label: text, value: String(secs) }))}
                triggerClassName="min-h-[44px] py-2.5 sm:min-h-[44px] px-3"
                valueClassName="text-sm"
              />
            </div>
          </div>

          <p className="mt-2 text-xs text-grey-50 dark:text-grey-dark-600">
            {linkWarning({ folder, role, neverExpires: ttlSecs === NEVER_EXPIRES_SECS })}
          </p>

          <Button
            type="button"
            variant="raised"
            size="auto"
            disabled={running}
            onClick={() => void mint(role)}
            className="mt-3 h-[40px] w-full rounded-[8px] text-sm font-medium @sm:w-auto @sm:px-5"
          >
            <span className="flex items-center justify-center gap-2">
              <Icons.Link className="size-4" />
              {running ? "Creating link…" : "Create link"}
            </span>
          </Button>
        </>
      )}

      {noticeView}
    </section>
  );
}

/**
 * The finished link: truncated with the `#k=` key hidden (the fragment is
 * the drive or folder key and must not appear on screen), a copy button that
 * writes the FULL URL, and what the link grants.
 */
function CreatedLink({ link, onAnother }: { link: DriveInviteLink; onAnother: () => void }) {
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
    <div>
      <div
        className={cn(
          "flex items-center gap-2 rounded-[8px] border py-1.5 pl-3 pr-1.5",
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
      <p className="mt-2 text-xs text-grey-50 dark:text-grey-dark-600">{describeCreatedLink(link)}</p>
      {copyFailed ? (
        <p className="mt-1 text-xs text-error-70">Could not copy the link. Try again.</p>
      ) : null}
      <button
        type="button"
        onClick={onAnother}
        className="mt-2 text-xs font-medium text-primary-50 hover:underline dark:text-primary-brand-dark"
      >
        Create another link
      </button>
    </div>
  );
}

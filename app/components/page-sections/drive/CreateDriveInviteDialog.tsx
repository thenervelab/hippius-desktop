"use client";

// Creating a drive invite link.
//
// A dialog rather than a tab in the sharing panel, deliberately. Minting is a
// short decision-shaped flow -- pick who they join as, pick how long the link
// lives, press the button, copy what comes back -- and it ends. The panel is
// for the opposite: managing what already exists, which is two lists that grow.
// Putting the wizard inside the list surface made both worse.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { Button, Icons } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Select } from "@/components/ui/select/Select";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/utils/errorUtils";
import { FOLDER_ROLES_ENABLED, SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  createDriveInviteDialogAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { useSharedDrivesInPlan } from "@/app/lib/hooks/useSharedDrivesInPlan";
import { invalidateOwnedDriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import {
  createDriveInvite,
  createFolderInvite,
  emailDriveInvite,
  emailInvitesAvailable,
  isEmailInvitesUnavailable,
  isFolderEditorInvitesUnavailable,
  isFolderEmailInvitesUnavailable,
  isFolderInvitesUnavailable,
  isSharedDrivesNotEntitled,
  isSharedDrivesUnavailable,
} from "@/app/lib/tauri/sharedDrives";
import Input from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  DRIVE_ROLES,
  MANAGER_INVITE_MAX_SECONDS,
  MANAGER_INVITE_MAX_USES,
  driveRoleDescription,
  driveRoleLabel,
  type DriveRole,
} from "@/app/lib/shared-drives/roles";
import {
  COMING_SOON_COPY,
  DEFAULT_INVITE_TTL_SECS,
  EMAIL_INVITE_ROLES,
  EMAIL_INVITE_TTL_OPTIONS,
  FOLDER_INVITE_ROLES,
  FOLDER_INVITE_TTL_OPTIONS,
  NEVER_EXPIRES_SECS,
  clampEmailInviteTtl,
  clampFolderInviteTtl,
  clampInviteTtl,
  inviteTtlOptionsFor,
  type ComingSoonNotice,
  type InviteState,
} from "./shareDriveModalState";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { inviteDriveDisplayName } from "@/app/lib/shared-drives/inviteDriveName";
import { truncateInviteUrl } from "@/app/lib/shared-drives/inviteLink";
import { useSharedDriveMemberships } from "@/app/lib/hooks/useSharedDriveRoles";
import { parseSharedDriveLabel } from "@/app/lib/shared-drives/sharedDriveLabel";

const primaryButtonClass =
  "h-[38px] w-full rounded-[8px] text-[14px] font-medium leading-[1.4] tracking-[-0.28px]";
const secondaryButtonClass =
  "h-[38px] w-full rounded-[8px] border border-grey-80 text-[14px] font-medium leading-[1.4] tracking-[-0.28px] text-grey-10 dark:border-white/10 dark:text-white";

export default function CreateDriveInviteDialog() {
  const [target, setTarget] = useAtom(createDriveInviteDialogAtom);
  const queryClient = useQueryClient();
  const planIncludesSharedDrives = useSharedDrivesInPlan();
  const [invite, setInvite] = useState<InviteState>({ kind: "choosing" });
  const [ttlSecs, setTtlSecs] = useState<number>(DEFAULT_INVITE_TTL_SECS);
  // `writer` is what every build before the picker minted, so the default
  // choice changes nothing for someone who does not touch it.
  const [inviteRole, setInviteRole] = useState<DriveRole>("writer");
  // "Link" mints a copyable URL; "Email" has the server mail the invitation.
  const [mode, setMode] = useState<InviteMode>("link");
  const [email, setEmail] = useState("");
  // A "coming soon" the server (or the mail probe) gave for what is on the
  // form right now. Inline, beside the choice it is about; cleared when that
  // choice changes.
  const [notice, setNotice] = useState<ComingSoonNotice | null>(null);
  // The mail probe, as a HINT only: the Email option is always offered, and a
  // known "no mail here" just says so before anyone types an address.
  const [emailHint, setEmailHint] = useState<boolean | null>(null);
  const autoCopiedRef = useRef(false);
  const label = target?.label ?? null;
  // A FOLDER invite is decided by the key being present, never by its value:
  // an empty folder path goes to the folder command (which refuses it) rather
  // than quietly turning into a whole-drive invite.
  const isFolderInvite = target?.pathPrefix !== undefined;
  const pathPrefix = isFolderInvite ? (target?.pathPrefix ?? "").trim() : null;
  // Folder collaboration (the staging-only flag): a folder invite gets the
  // Viewer / Editor picker and the email option. Off, a folder invite stays
  // view-only, link-only and single use, exactly as before.
  const folderRolesEnabled = FOLDER_ROLES_ENABLED;
  const folderRoles = isFolderInvite && folderRolesEnabled;
  const emailOffered = !isFolderInvite || folderRoles;
  const currentLabelRef = useRef<string | null>(null);
  currentLabelRef.current = label;

  // A fresh open starts a fresh mint, never the previous drive's finished link.
  //
  // A plan without the perk opens STRAIGHT into the upgrade prompt rather
  // than letting someone configure a link the server will refuse. The
  // surface is deliberately not hidden from them -- hiding it hid the
  // feature's existence from the people most likely to buy it -- so this is
  // where they are told, once, with the plans named.
  useEffect(() => {
    if (target) {
      setInvite(
        planIncludesSharedDrives === false
          ? { kind: "notEntitled" }
          : { kind: "choosing" },
      );
      // Folder invites are capped at 30 days server-side; default to 7 days.
      setTtlSecs(DEFAULT_INVITE_TTL_SECS);
      setInviteRole(isFolderInvite ? "reader" : "writer");
      setMode("link");
      setEmail("");
      setNotice(null);
      autoCopiedRef.current = false;
    }
    // `undefined` while the plan is still loading: the dialog opens on the
    // form and the server's own refusal is the backstop, rather than
    // flashing an upgrade prompt at somebody who has already paid.
  }, [target, planIncludesSharedDrives, isFolderInvite]);

  const driveTarget = useMemo(
    () =>
      target?.ownerSs58 && target?.folderHash
        ? { ownerSs58: target.ownerSs58, folderHash: target.folderHash }
        : undefined,
    [target?.ownerSs58, target?.folderHash],
  );

  // Ask once per open whether this server can mail invitations (a hint).
  useEffect(() => {
    setEmailHint(null);
    if (!label || !emailOffered) return;
    let cancelled = false;
    emailInvitesAvailable(label, driveTarget)
      .then((available) => {
        if (!cancelled) setEmailHint(available);
      })
      .catch(() => {
        // Unknown stays unknown: sending is still the real answer.
      });
    return () => {
      cancelled = true;
    };
  }, [label, emailOffered, driveTarget]);

  // Whatever the server refused, as a "coming soon" beside the choice, or a
  // terminal state. Rust decides the kind; this only routes it.
  const handleRefusal = useCallback((err: unknown): boolean => {
    if (isEmailInvitesUnavailable(err)) {
      setEmailHint(false);
      setNotice("email");
    } else if (isFolderEmailInvitesUnavailable(err)) {
      setNotice("folderEmail");
    } else if (isFolderEditorInvitesUnavailable(err)) {
      setNotice("folderEditor");
    } else if (isFolderInvitesUnavailable(err)) {
      setInvite({ kind: "folderComingSoon" });
      return true;
    } else if (isSharedDrivesUnavailable(err)) {
      setInvite({ kind: "unavailable" });
      return true;
    } else if (isSharedDrivesNotEntitled(err)) {
      setInvite({ kind: "notEntitled" });
      return true;
    } else {
      return false;
    }
    setInvite({ kind: "choosing" });
    return true;
  }, []);

  const sendEmailInvite = useCallback(async () => {
    if (!label) return;
    const labelAtCall = label;
    setInvite({ kind: "running" });
    setNotice(null);
    try {
      const role = inviteRole === "manager" ? "writer" : inviteRole;
      await emailDriveInvite(labelAtCall, email, {
        role,
        expiresInSecs: clampEmailInviteTtl(ttlSecs),
        target: driveTarget,
        ...(isFolderInvite && pathPrefix !== null ? { pathPrefix } : {}),
      });
      if (labelAtCall !== currentLabelRef.current) return;
      setInvite({ kind: "emailSent", email: email.trim() });
      void invalidateOwnedDriveSharing(queryClient);
    } catch (err) {
      if (labelAtCall !== currentLabelRef.current) return;
      if (!handleRefusal(err)) {
        // Rust words the rate limit (with the wait) and the failed send.
        setInvite({ kind: "error", message: errorMessage(err) });
      }
    }
  }, [label, email, inviteRole, ttlSecs, driveTarget, queryClient, isFolderInvite, pathPrefix, handleRefusal]);

  const handleModeChange = useCallback((next: InviteMode) => {
    setMode(next);
    setNotice(null);
    if (next === "email") {
      // A Manager invite has to be a link, and a mailed one cannot outlive
      // thirty days: snap both so the form never describes a refusal.
      setInviteRole((r) => (r === "manager" ? "writer" : r));
      setTtlSecs((secs) => clampEmailInviteTtl(secs));
    }
  }, []);

  const mintInvite = useCallback(async () => {
    if (!label) return;
    const labelAtCall = label;
    setInvite({ kind: "running" });
    setNotice(null);
    autoCopiedRef.current = false;
    try {
      let link;
      if (isFolderInvite) {
        // One person, one folder, at most 30 days: Rust owns the policy and
        // refuses an empty folder. Never the drive command.
        link = await createFolderInvite(labelAtCall, pathPrefix ?? "", {
          expiresInSecs: clampFolderInviteTtl(ttlSecs),
          role: folderRoles && inviteRole === "writer" ? "writer" : "reader",
          target: driveTarget,
        });
      } else {
        // A manager invite is capped by the server at one use and 24 hours,
        // and exceeding either is a 400. Clamping here (and again in Rust)
        // means the link the user gets is the link the form described,
        // rather than a rejection after the fact (console parity).
        const isManager = inviteRole === "manager";
        link = await createDriveInvite(labelAtCall, {
          expiresInSecs: isManager
            ? Math.min(ttlSecs, MANAGER_INVITE_MAX_SECONDS)
            : ttlSecs,
          ...(isManager ? { maxUses: MANAGER_INVITE_MAX_USES } : {}),
          role: inviteRole,
          // Named only for a drive shared with this account that is not
          // synced here; an own drive's label resolves on its own.
          target: driveTarget,
        });
      }
      if (labelAtCall !== currentLabelRef.current) return;
      setInvite({ kind: "done", inviteUrl: link.inviteUrl });
      // The drive is shared from this moment: its row grows the badge and
      // Manage access as soon as the dialog closes, not on the next launch.
      void invalidateOwnedDriveSharing(queryClient);
    } catch (err) {
      if (labelAtCall !== currentLabelRef.current) return;
      if (!handleRefusal(err)) {
        setInvite({ kind: "error", message: errorMessage(err) });
      }
    }
  }, [
    label,
    ttlSecs,
    inviteRole,
    queryClient,
    driveTarget,
    pathPrefix,
    isFolderInvite,
    folderRoles,
    handleRefusal,
  ]);

  const handleRoleChange = useCallback((role: DriveRole) => {
    setInviteRole(role);
    setNotice((n) => (n === "folderEditor" ? null : n));
    // Choosing Manager with a wider lifetime already selected must snap the
    // picker, not leave a value the mint would quietly replace (console).
    setTtlSecs((secs) => clampInviteTtl(role, secs));
  }, []);

  const handleEmailChange = useCallback((next: string) => {
    setEmail(next);
  }, []);

  useEffect(() => {
    if (invite.kind !== "done" || autoCopiedRef.current) return;
    autoCopiedRef.current = true;
    navigator.clipboard
      .writeText(invite.inviteUrl)
      .then(() => toast.success("Invite link copied to clipboard"))
      .catch((err: unknown) => {
        console.warn("[CreateDriveInviteDialog] auto-copy failed:", err);
      });
  }, [invite]);

  const memberships = useSharedDriveMemberships();
  // Prefer the human basename the caller passed; when that is still the
  // synthetic `shared:…` browse label (Manage access opened before the
  // display-name map was populated), resolve it from memberships.
  const driveName = (() => {
    const preferred = inviteDriveDisplayName(target?.folderName, target?.label);
    if (preferred !== "this drive" || !target) return preferred;
    const identity =
      parseSharedDriveLabel(target.label) ??
      parseSharedDriveLabel(target.folderName) ??
      (target.ownerSs58 && target.folderHash
        ? { ownerSs58: target.ownerSs58, folderHash: target.folderHash }
        : null);
    if (!identity) return preferred;
    const match = memberships.find(
      (m) =>
        m.ownerSs58 === identity.ownerSs58 &&
        m.folderHash === identity.folderHash,
    );
    return inviteDriveDisplayName(match?.displayLabel, target.label);
  })();

  // The folder's path says where it is; its own name when the path is empty.
  const folderTitle = pathPrefix || target?.folderName || null;

  if (!SHARED_DRIVES_ENABLED || !target) return null;

  return (
    <FramedDialog
      open
      onClose={() => setTarget(null)}
      title={
        <span className="mx-auto flex w-full min-w-0 max-w-full flex-col items-center gap-0.5 px-2">
          <span className="shrink-0">
            {isFolderInvite ? "Share folder" : "Invite to"}
          </span>
          <span
            className="block w-full min-w-0 truncate"
            title={isFolderInvite ? folderTitle ?? driveName : driveName}
          >
            &quot;{isFolderInvite ? folderTitle : driveName}&quot;
          </span>
        </span>
      }
      titleClassName="w-full min-w-0 overflow-hidden"
      icon={<Icons.Link className="size-4 text-white" />}
      // The canonical decision-dialog recipe (ConfirmationDialog,
      // DeleteConfirmationDialog): a 585px card with a 405px content column
      // inside it. FramedDialog's ring + border + card padding eats ~104px a
      // side on `sm+`, so a narrower card crushes the column, and letting the
      // column run the card's full width leaves two selects and two stacked
      // buttons stretched across 585px with nothing in them.
      maxWidth="max-w-[585px]"
      contentClassName="sm:w-[405px] min-w-0 overflow-hidden"
    >
      <div className="font-geist">
        <InviteTab
          state={invite}
          ttlSecs={ttlSecs}
          onTtlChange={setTtlSecs}
          role={inviteRole}
          onRoleChange={handleRoleChange}
          folderInvite={isFolderInvite}
          folderRoles={folderRoles}
          mode={mode}
          onModeChange={handleModeChange}
          emailOffered={emailOffered}
          emailKnownUnavailable={emailHint === false}
          notice={notice}
          email={email}
          onEmailChange={handleEmailChange}
          onSendEmail={() => void sendEmailInvite()}
          onMint={() => void mintInvite()}
          onRetry={() => setInvite({ kind: "choosing" })}
          onClose={() => setTarget(null)}
        />
      </div>
    </FramedDialog>
  );
}

type InviteMode = "link" | "email";

/**
 * A "coming soon" said inline, in the dialogs' existing amber notice recipe
 * (the migration prompt's), so it reads as a note about the choice beside it
 * rather than as an error.
 */
export function ComingSoonInlineNotice({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-warning-50/40 bg-warning-50/10 p-3 dark:border-warning-50/35 dark:bg-warning-50/[0.12]",
        className,
      )}
    >
      <Icons.InfoCircle className="mt-0.5 size-4 shrink-0 text-warning-50" />
      <p className="min-w-0 break-words text-xs leading-5 text-grey-40 dark:text-grey-dark-700">
        {children}
      </p>
    </div>
  );
}

function InviteTab({
  state,
  ttlSecs,
  onTtlChange,
  role,
  onRoleChange,
  folderInvite = false,
  folderRoles = false,
  mode,
  onModeChange,
  emailOffered,
  emailKnownUnavailable,
  notice,
  email,
  onEmailChange,
  onSendEmail,
  onMint,
  onRetry,
  onClose,
}: {
  state: InviteState;
  ttlSecs: number;
  onTtlChange: (secs: number) => void;
  role: DriveRole;
  onRoleChange: (role: DriveRole) => void;
  folderInvite?: boolean;
  /** A folder invite with the Viewer / Editor picker (folder roles on). */
  folderRoles?: boolean;
  mode: InviteMode;
  onModeChange: (mode: InviteMode) => void;
  /** Whether "Invite by email" is offered at all (never hidden on a probe). */
  emailOffered: boolean;
  /** The mail probe already said this server cannot send mail. */
  emailKnownUnavailable: boolean;
  notice: ComingSoonNotice | null;
  email: string;
  onEmailChange: (email: string) => void;
  onSendEmail: () => void;
  onMint: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const neverExpires = ttlSecs === NEVER_EXPIRES_SECS;

  if (state.kind === "done") {
    return (
      <InviteDone
        inviteUrl={state.inviteUrl}
        neverExpires={neverExpires}
        folderInvite={folderInvite}
        onClose={onClose}
      />
    );
  }

  if (state.kind === "emailSent") {
    return <EmailInviteSent email={state.email} folderInvite={folderInvite} onClose={onClose} />;
  }

  if (state.kind === "unavailable") {
    return <SharedDrivesUnavailableNotice onClose={onClose} />;
  }

  if (state.kind === "notEntitled") {
    return <SharedDrivesNotEntitledNotice onClose={onClose} />;
  }

  if (state.kind === "folderComingSoon") {
    return (
      <div>
        <ComingSoonInlineNotice className="mb-6">
          {COMING_SOON_COPY.folder}
        </ComingSoonInlineNotice>
        <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
          Close
        </Button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <div className="mb-6 flex items-start gap-2 rounded-md border border-error-90 bg-error-100/40 px-3 py-2.5 dark:border-error-30/60 dark:bg-error-30/10">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-error-70" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-error-70">
              {mode === "email" ? "Couldn't send the invitation" : "Couldn't create invite link"}
            </p>
            <p className="mt-1 break-words text-xs text-grey-50 dark:text-grey-dark-600">{state.message}</p>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Button type="button" variant="primary" size="auto" onClick={onRetry} className={primaryButtonClass}>
            Try again
          </Button>
          <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const running = state.kind === "running";
  const byEmail = emailOffered && mode === "email";
  // What the email field says about mail on this server: the refusal the
  // server gave, else the probe's hint.
  const emailNotice: ComingSoonNotice | null =
    notice === "email" || notice === "folderEmail"
      ? notice
      : byEmail && emailKnownUnavailable
        ? "email"
        : null;
  // Folder invites without roles are always Viewer; with them, the picker.
  const pickRole = !folderInvite || folderRoles;
  const managerCapped = !folderInvite && !byEmail && role === "manager";
  const ttlOptions = byEmail
    ? EMAIL_INVITE_TTL_OPTIONS
    : folderInvite
      ? FOLDER_INVITE_TTL_OPTIONS
      : inviteTtlOptionsFor(role);
  const roleOptions = folderInvite
    ? FOLDER_INVITE_ROLES
    : byEmail
      ? EMAIL_INVITE_ROLES
      : DRIVE_ROLES;
  const emailReady = email.trim().length > 0;
  const sendBlocked = running || !emailReady || emailNotice === "email";
  return (
    <div>
      {emailOffered ? (
        <div className="mb-5">
          <SegmentedControl<InviteMode>
            ariaLabel="How to invite"
            fullWidth
            value={mode}
            onChange={onModeChange}
            options={[
              { label: "Copy link", value: "link" },
              { label: "Invite by email", value: "email" },
            ]}
          />
        </div>
      ) : null}

      {byEmail ? (
        <div className="mb-5 flex flex-col gap-1.5">
          <label
            htmlFor="invite-email"
            className="text-xs font-medium text-grey-30 dark:text-grey-dark-700"
          >
            Email address
          </label>
          <Input
            id="invite-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !sendBlocked) onSendEmail();
            }}
            wrapperClassName="min-h-[44px] py-2.5 sm:min-h-[44px]"
            className="text-sm"
          />
          {emailNotice ? (
            <ComingSoonInlineNotice className="mt-1">
              {COMING_SOON_COPY[emailNotice]}
            </ComingSoonInlineNotice>
          ) : (
            <p className="mt-1 text-xs text-grey-50 dark:text-grey-dark-600">
              We email them a single-use invitation. Once they open it, approve
              them from the Links tab so they can join.
            </p>
          )}
        </div>
      ) : null}
      {!pickRole ? (
        <p className="mb-5 text-sm text-grey-50 dark:text-grey-dark-600">
          Creates a view-only, single-use link. The recipient opens it in the
          console to join; the desktop app does not accept invite links.
        </p>
      ) : (
        <div className="mb-5 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">
            They join as
          </span>
          <Select
            ariaLabel="Invite role"
            value={role}
            onValueChange={(value) => onRoleChange(value as DriveRole)}
            options={roleOptions.map((r) => ({
              label: driveRoleLabel(r),
              value: r,
            }))}
          />
          <p className="mt-1 text-xs text-grey-50 dark:text-grey-dark-600">
            {folderInvite ? folderRoleDescription(role) : driveRoleDescription(role)}
          </p>
          {managerCapped ? (
            <p className="text-xs text-grey-50 dark:text-grey-dark-600">
              Manager links are single use and expire in 24 hours.
            </p>
          ) : null}
          {notice === "folderEditor" ? (
            <ComingSoonInlineNotice className="mt-1">
              {COMING_SOON_COPY.folderEditor}
            </ComingSoonInlineNotice>
          ) : null}
        </div>
      )}

      <div className="mb-6 flex flex-col gap-1.5">
        <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">Invite expires</span>
        <Select
          ariaLabel="Invite expires"
          value={String(ttlSecs)}
          onValueChange={(value) => onTtlChange(Number(value))}
          options={ttlOptions.map(({ label, secs }) => ({
            label,
            value: String(secs),
          }))}
        />
        <p className="mt-1 text-xs text-grey-50 dark:text-grey-dark-600">
          {byEmail
            ? `Only the person who opens the email can use it, as ${driveRoleLabel(role)}, and only until it expires.`
            : folderInvite
            ? `The link works once: the first person who opens it joins this folder as ${pickRole ? driveRoleLabel(role) : "a viewer"}, until it expires. They see this folder and what is inside it, nothing above it.`
            : managerCapped
              ? "A manager link can only be used once and expires within 24 hours. Managers can invite and remove people, so the link itself is short-lived."
              : neverExpires
                ? `Anyone with the link can join this drive as ${driveRoleLabel(role)} for as long as the link exists. Share it only with people you trust.`
                : `Anyone with the link can join this drive as ${driveRoleLabel(role)} until the link expires. Share it only with people you trust.`}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {byEmail ? (
          <Button
            type="button"
            variant="primary"
            size="auto"
            disabled={sendBlocked}
            onClick={onSendEmail}
            className={primaryButtonClass}
          >
            {running ? "Sending invitation…" : "Send invitation"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="auto"
            disabled={running}
            onClick={onMint}
            className={primaryButtonClass}
          >
            {running ? "Creating invite link…" : "Create invite link"}
          </Button>
        )}
        <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** What a folder role lets its holder do: only inside this folder. */
function folderRoleDescription(role: DriveRole): string {
  return role === "writer"
    ? "Can open, download, add, rename and delete files in this folder."
    : "Can open and download files in this folder.";
}

function InviteDone({
  inviteUrl,
  neverExpires,
  folderInvite,
  onClose,
}: {
  inviteUrl: string;
  neverExpires: boolean;
  folderInvite: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (copied) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Invite link copied to clipboard");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error(`Could not copy link: ${errorMessage(err)}`);
    }
  };

  // Title, then what the link grants, then the link, then the action on it,
  // then the way out. The explanation used to sit BETWEEN the copy button and
  // Done, which put a paragraph in the one gap the eye travels fastest and
  // left the title sitting directly on top of an opaque blob of URL.
  return (
    <div>
      <p className="mb-4 text-center text-xs text-grey-50 dark:text-grey-dark-600">
        {folderInvite
          ? "This link works once: the first person who opens it joins this folder, and only this folder, until it expires. "
          : neverExpires
            ? "This link never expires. Anyone who has it can join the drive. "
            : "Anyone with this link can join the drive until it expires. "}
        {/* The old copy sent people to Members to "revoke access", which only
            removes someone who already joined and does nothing about a link
            still circulating. Now that links can be revoked, say so. */}
        Revoke the link itself in the Links tab, or remove someone who has
        already joined from Members.
      </p>

      <div
        className={cn(
          "mb-3 flex items-center gap-2 rounded-[8px] border px-3 py-2.5",
          "border-grey-80 bg-white",
          "dark:border-[#494949] dark:bg-[#1f1f1f]",
        )}
      >
        {/* Truncated, `#k=` stripped: the fragment is the drive key and must
            not appear on screen. Copy still writes the full URL. */}
        <p
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs",
            "text-grey-10 dark:text-grey-dark-800",
          )}
          title="Invite link (key fragment hidden)"
        >
          {truncateInviteUrl(inviteUrl)}
        </p>
      </div>

      {/* The link is the whole point of this screen, so copying it is the
          primary action rather than an icon tucked beside the field, and it
          sits directly under the thing it copies. */}
      <Button
        type="button"
        variant="primary"
        size="auto"
        onClick={() => void handleCopy()}
        className={cn(primaryButtonClass, "mb-3 flex items-center justify-center gap-2")}
      >
        {copied ? <Check className="size-4" /> : <Icons.Copy className="size-4" />}
        {copied ? "Copied to clipboard" : "Copy link"}
      </Button>

      <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
        Done
      </Button>
    </div>
  );
}

/** A mailed invitation went out. There is no link to copy: only the mail has it. */
function EmailInviteSent({
  email,
  folderInvite,
  onClose,
}: {
  email: string;
  folderInvite: boolean;
  onClose: () => void;
}) {
  return (
    <div>
      <div className="mb-3 flex justify-center">
        <span className="flex size-9 items-center justify-center rounded-full bg-success-100 text-success-40 dark:bg-success-50/15 dark:text-success-50">
          <Check className="size-4" />
        </span>
      </div>
      <p className="mb-1.5 text-center text-sm font-medium text-grey-10 dark:text-white">
        Invitation sent
      </p>
      <p className="mb-6 break-words text-center text-xs text-grey-50 dark:text-grey-dark-600">
        We emailed {email}. When they open it, it shows up in the Links tab
        waiting for your approval. Approving lets them join{" "}
        {folderInvite ? "this folder" : "the drive"}.
      </p>
      <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
        Done
      </Button>
    </div>
  );
}

function SharedDrivesUnavailableNotice({ onClose }: { onClose: () => void }) {
  return (
    <div>
      <p className="mb-6 py-4 text-center text-sm text-grey-50 dark:text-grey-dark-600">
        Shared drives aren&apos;t available on your server yet.
      </p>
      <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
        Close
      </Button>
    </div>
  );
}

// The mint plan gate (`SHARED_DRIVES_NOT_ENTITLED`): the drive owner's plan
// does not include sharing. An upgrade prompt, not an error: no retry, no
// toast. The same for a drive and a folder invite.
//
// The CTA goes to the in-app Subscription Plans page, the same destination
// every other Drive upgrade prompt uses (`InsufficientCreditsDialog`, the
// files empty state, the plan chip), not the console, where the user would
// have to sign in again to change a plan the app can change itself.
function SharedDrivesNotEntitledNotice({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const upgrade = () => {
    onClose();
    router.push(BILLING_ROUTE);
  };

  return (
    <div>
      <p className="mb-1.5 pt-2 text-center text-sm font-medium text-grey-30 dark:text-grey-dark-700">
        Sharing needs a Plus, Max or Scale plan
      </p>
      <p className="mb-6 text-center text-xs text-grey-50 dark:text-grey-dark-600">
        Upgrade your plan to share drives and folders. Anyone
        you&apos;ve already shared with keeps their access.
      </p>
      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="primary"
          size="auto"
          onClick={upgrade}
          className={primaryButtonClass}
        >
          Upgrade plan
        </Button>
        <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
          Close
        </Button>
      </div>
    </div>
  );
}

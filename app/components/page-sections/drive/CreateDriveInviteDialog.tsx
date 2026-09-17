"use client";

// Creating a drive invite link.
//
// A dialog rather than a tab in the sharing panel, deliberately. Minting is a
// short decision-shaped flow -- pick who they join as, pick how long the link
// lives, press the button, copy what comes back -- and it ends. The panel is
// for the opposite: managing what already exists, which is two lists that grow.
// Putting the wizard inside the list surface made both worse.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { AlertCircle, Check } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { Button, Icons } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Select } from "@/components/ui/select/Select";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/utils/errorUtils";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { createDriveInviteDialogAtom } from "@/app/lib/global-atoms/sharesAtoms";
import {
  createDriveInvite,
  isSharedDrivesNotEntitled,
  isSharedDrivesUnavailable,
} from "@/app/lib/tauri/sharedDrives";
import {
  DRIVE_ROLES,
  MANAGER_INVITE_MAX_SECONDS,
  driveRoleDescription,
  driveRoleLabel,
  type DriveRole,
} from "@/app/lib/shared-drives/roles";
import {
  DEFAULT_INVITE_TTL_SECS,
  INVITE_TTL_OPTIONS,
  NEVER_EXPIRES_SECS,
  type InviteState,
} from "./shareDriveModalState";
import { BILLING_ROUTE } from "@/app/lib/routes";

const primaryButtonClass =
  "h-[38px] w-full rounded-[8px] text-[14px] font-medium leading-[1.4] tracking-[-0.28px]";
const secondaryButtonClass =
  "h-[38px] w-full rounded-[8px] border border-grey-80 text-[14px] font-medium leading-[1.4] tracking-[-0.28px] text-grey-10 dark:border-white/10 dark:text-white";

export default function CreateDriveInviteDialog() {
  const [target, setTarget] = useAtom(createDriveInviteDialogAtom);
  const [invite, setInvite] = useState<InviteState>({ kind: "choosing" });
  const [ttlSecs, setTtlSecs] = useState<number>(DEFAULT_INVITE_TTL_SECS);
  // `writer` is what every build before the picker minted, so the default
  // choice changes nothing for someone who does not touch it.
  const [inviteRole, setInviteRole] = useState<DriveRole>("writer");
  const autoCopiedRef = useRef(false);
  const label = target?.label ?? null;
  const currentLabelRef = useRef<string | null>(null);
  currentLabelRef.current = label;

  // A fresh open starts a fresh mint, never the previous drive's finished link.
  useEffect(() => {
    if (target) {
      setInvite({ kind: "choosing" });
      setTtlSecs(DEFAULT_INVITE_TTL_SECS);
      setInviteRole("writer");
      autoCopiedRef.current = false;
    }
  }, [target]);

  const mintInvite = useCallback(async () => {
    if (!label) return;
    const labelAtCall = label;
    setInvite({ kind: "running" });
    autoCopiedRef.current = false;
    try {
      // A manager invite is capped by the server at one use and 24 hours, and
      // exceeding either is a 400. Clamping here means the link the user gets
      // is the link the form described, rather than a rejection after the fact.
      const effectiveTtl =
        inviteRole === "manager"
          ? Math.min(ttlSecs, MANAGER_INVITE_MAX_SECONDS)
          : ttlSecs;
      const link = await createDriveInvite(labelAtCall, {
        expiresInSecs: effectiveTtl,
        role: inviteRole,
      });
      if (labelAtCall !== currentLabelRef.current) return;
      setInvite({ kind: "done", inviteUrl: link.inviteUrl });
    } catch (err) {
      if (labelAtCall !== currentLabelRef.current) return;
      if (isSharedDrivesUnavailable(err)) {
        setInvite({ kind: "unavailable" });
      } else if (isSharedDrivesNotEntitled(err)) {
        setInvite({ kind: "notEntitled" });
      } else {
        setInvite({ kind: "error", message: errorMessage(err) });
      }
    }
  }, [label, ttlSecs, inviteRole]);

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

  if (!SHARED_DRIVES_ENABLED || !target) return null;

  return (
    <FramedDialog
      open
      onClose={() => setTarget(null)}
      title={`Invite to "${target.folderName}"`}
      icon={<Icons.Link className="size-4 text-white" />}
      maxWidth="max-w-[460px]"
    >
      <div className="font-geist">
        <InviteTab
          state={invite}
          ttlSecs={ttlSecs}
          onTtlChange={setTtlSecs}
          role={inviteRole}
          onRoleChange={setInviteRole}
          onMint={() => void mintInvite()}
          onRetry={() => setInvite({ kind: "choosing" })}
          onClose={() => setTarget(null)}
        />
      </div>
    </FramedDialog>
  );
}

function InviteTab({
  state,
  ttlSecs,
  onTtlChange,
  role,
  onRoleChange,
  onMint,
  onRetry,
  onClose,
}: {
  state: InviteState;
  ttlSecs: number;
  onTtlChange: (secs: number) => void;
  role: DriveRole;
  onRoleChange: (role: DriveRole) => void;
  onMint: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const neverExpires = ttlSecs === NEVER_EXPIRES_SECS;

  if (state.kind === "done") {
    return <InviteDone inviteUrl={state.inviteUrl} neverExpires={neverExpires} onClose={onClose} />;
  }

  if (state.kind === "unavailable") {
    return <SharedDrivesUnavailableNotice onClose={onClose} />;
  }

  if (state.kind === "notEntitled") {
    return <SharedDrivesNotEntitledNotice onClose={onClose} />;
  }

  if (state.kind === "error") {
    return (
      <div>
        <div className="mb-6 flex items-start gap-2 rounded-md border border-error-90 bg-error-100/40 px-3 py-2.5 dark:border-error-30/60 dark:bg-error-30/10">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-error-70" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-error-70">Couldn&apos;t create invite link</p>
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
  const managerCapped = role === "manager";
  return (
    <div>
      <div className="mb-5 flex flex-col gap-1.5">
        <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">
          They join as
        </span>
        <Select
          ariaLabel="Invite role"
          value={role}
          onValueChange={(value) => onRoleChange(value as DriveRole)}
          options={DRIVE_ROLES.map((r) => ({
            label: driveRoleLabel(r),
            value: r,
          }))}
        />
        <p className="mt-1 text-xs text-grey-50 dark:text-grey-dark-600">
          {driveRoleDescription(role)}
        </p>
      </div>

      <div className="mb-6 flex flex-col gap-1.5">
        <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">Invite expires</span>
        <Select
          ariaLabel="Invite expires"
          value={String(ttlSecs)}
          onValueChange={(value) => onTtlChange(Number(value))}
          options={INVITE_TTL_OPTIONS.map(({ label, secs }) => ({
            label,
            value: String(secs),
          }))}
        />
        <p className="mt-1 text-xs text-grey-50 dark:text-grey-dark-600">
          {managerCapped
            ? "A manager link can only be used once and expires within 24 hours, whatever is chosen above — managers can invite and remove people, so the link itself is short-lived."
            : neverExpires
              ? `Anyone with the link can join this drive as ${driveRoleLabel(role)} for as long as the link exists. Share it only with people you trust.`
              : `Anyone with the link can join this drive as ${driveRoleLabel(role)} until the link expires. Share it only with people you trust.`}
        </p>
      </div>

      <div className="flex flex-col gap-3">
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
        <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function InviteDone({
  inviteUrl,
  neverExpires,
  onClose,
}: {
  inviteUrl: string;
  neverExpires: boolean;
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

  return (
    <div>
      <div
        className={cn(
          "mb-3 flex items-start gap-2 rounded-[8px] border p-3",
          "border-grey-80 bg-white",
          "dark:border-[#494949] dark:bg-[#1f1f1f]",
        )}
      >
        <textarea
          readOnly
          value={inviteUrl}
          onFocus={(e) => e.currentTarget.select()}
          rows={2}
          className={cn(
            "flex-1 resize-none overflow-hidden break-all bg-transparent font-mono text-xs outline-none",
            "text-grey-10 dark:text-grey-dark-800",
          )}
        />
      </div>

      {/* The link is the whole point of this screen, so copying it is the
          primary action rather than an icon tucked beside the field. */}
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

      <p className="mb-6 text-xs text-grey-50 dark:text-grey-dark-600">
        {neverExpires
          ? "This link never expires — anyone who has it can join the drive. "
          : "Anyone with this link can join the drive until it expires. "}
        {/* The old copy sent people to Members to "revoke access", which only
            removes someone who already joined and does nothing about a link
            still circulating. Now that links can be revoked, say so. */}
        Revoke the link itself in the Links tab, or remove someone who has
        already joined from Members.
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
// does not include shared drives. An upgrade prompt, not an error — no retry,
// no toast. Shown only to owners (the "Share drive…" surface is owner-only).
//
// The CTA goes to the in-app Subscription Plans page, the same destination
// every other Drive upgrade prompt uses (`InsufficientCreditsDialog`, the
// files empty state, the plan chip) — not the console, where the user would
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
        Shared drives need Plus, Max, or Scale
      </p>
      <p className="mb-6 text-center text-xs text-grey-50 dark:text-grey-dark-600">
        Upgrade this drive&apos;s plan to invite members. Anyone you&apos;ve
        already shared with keeps their access.
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

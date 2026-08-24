// Owner-side management modal for a shared drive: mint invite links and
// list/remove members. Opened via `shareDriveModalAtom` (the
// `ShareFileModal` singleton pattern — mounted once in the pages layout,
// any surface opens it by setting the atom). Own drives only: the
// "Share drive…" menu item is hidden for member rows and the backend
// refuses a member label as `Validation`.
//
// Invite tab lifecycle (`shareDriveModalState.ts::InviteState`):
//
//   `choosing`    — expiry preset picker; nothing is minted yet.
//   `running`     — `create_drive_invite` in flight.
//   `done`        — link ready, auto-copied once; read-only URL + copy.
//   `unavailable` — feature-off server (`SHARED_DRIVES_UNAVAILABLE`):
//                   quiet degrade copy, no retry, never a toast.
//   `error`       — anything else. Inline message + Try again / Close.
//
// There is deliberately NO invite listing/revoke surface: the server
// stores only blake3 token hashes and exposes no list-invites endpoint,
// and the desktop never persists minted tokens — so after this dialog
// closes there is nothing to select for revocation. Owners revoke ACCESS
// by removing members (the Members tab); unclaimed links die by
// expiry/max-uses. See `shared_drives/commands.rs` module docs.

"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useAtom } from "jotai";
import { AlertCircle, Check } from "lucide-react";
import { toast } from "sonner";

import { Button, Icons } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/select/Select";
import { cn } from "@/lib/utils";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";
import {
  createDriveInvite,
  isSharedDrivesUnavailable,
  listDriveMembers,
  removeDriveMember,
  type DriveMemberInfo,
} from "@/app/lib/tauri/sharedDrives";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { middleTruncate } from "@/lib/utils/middleTruncate";
import {
  DEFAULT_INVITE_TTL_SECS,
  formatJoinedDate,
  getMembersView,
  INVITE_TTL_OPTIONS,
  NEVER_EXPIRES_SECS,
  type InviteState,
  type MembersState,
} from "./shareDriveModalState";

const Avatar = dynamic(() => import("boring-avatars"), { ssr: false });

type Tab = "invite" | "members";

export default function ShareDriveModal() {
  const [target, setTarget] = useAtom(shareDriveModalAtom);

  const [tab, setTab] = useState<Tab>("invite");
  const [invite, setInvite] = useState<InviteState>({ kind: "choosing" });
  const [ttlSecs, setTtlSecs] = useState<number>(DEFAULT_INVITE_TTL_SECS);
  const [members, setMembers] = useState<MembersState>({ kind: "idle" });
  // Auto-copy fires once per `done` transition (the ShareFileModal rule).
  const autoCopiedRef = useRef(false);

  const label = target?.label ?? null;
  // Stale-async guard: the modal never unmounts and `label` changes on
  // close/reopen, so a response still in flight for a previous drive must
  // not land on the current session's state (the reset effect below runs
  // before the late response resolves, then the response would clobber it).
  const currentLabelRef = useRef<string | null>(null);
  currentLabelRef.current = label;

  // Reset on every session transition, close included — the modal never
  // unmounts, so without this a previous drive's invite link or member
  // list would survive into the next open.
  useEffect(() => {
    setTab("invite");
    setInvite({ kind: "choosing" });
    setTtlSecs(DEFAULT_INVITE_TTL_SECS);
    setMembers({ kind: "idle" });
    autoCopiedRef.current = false;
  }, [label]);

  const loadMembers = useCallback(async (driveLabel: string) => {
    setMembers({ kind: "loading" });
    try {
      const rows = await listDriveMembers(driveLabel);
      if (driveLabel !== currentLabelRef.current) return;
      setMembers({ kind: "ready", members: rows });
    } catch (err) {
      if (driveLabel !== currentLabelRef.current) return;
      if (isSharedDrivesUnavailable(err)) {
        // Feature-off server: quiet degrade, never a toast.
        setMembers({ kind: "unavailable" });
      } else {
        setMembers({ kind: "error", message: errorMessage(err) });
      }
    }
  }, []);

  // Lazy members fetch: first activation of the tab only, so minting an
  // invite costs no member-listing round-trip.
  useEffect(() => {
    if (!label || tab !== "members") return;
    if (members.kind !== "idle") return;
    void loadMembers(label);
  }, [label, tab, members.kind, loadMembers]);

  const mintInvite = useCallback(async () => {
    if (!label) return;
    const labelAtCall = label;
    setInvite({ kind: "running" });
    autoCopiedRef.current = false;
    try {
      const link = await createDriveInvite(labelAtCall, { expiresInSecs: ttlSecs });
      if (labelAtCall !== currentLabelRef.current) return;
      setInvite({ kind: "done", inviteUrl: link.inviteUrl });
    } catch (err) {
      if (labelAtCall !== currentLabelRef.current) return;
      if (isSharedDrivesUnavailable(err)) {
        setInvite({ kind: "unavailable" });
      } else {
        setInvite({ kind: "error", message: errorMessage(err) });
      }
    }
  }, [label, ttlSecs]);

  // Auto-copy once we reach `done`; the URL stays in a selectable textbox
  // so the user can re-copy if focus rules block the auto-copy.
  useEffect(() => {
    if (invite.kind !== "done" || autoCopiedRef.current) return;
    autoCopiedRef.current = true;
    navigator.clipboard
      .writeText(invite.inviteUrl)
      .then(() => toast.success("Invite link copied to clipboard"))
      .catch((err: unknown) => {
        console.warn("[ShareDriveModal] auto-copy failed:", err);
      });
  }, [invite]);

  const removeMember = useCallback(
    async (memberSs58: string) => {
      if (!label) return;
      const labelAtCall = label;
      try {
        await removeDriveMember(labelAtCall, memberSs58);
        toast.success("Member removed");
        await loadMembers(labelAtCall);
      } catch (err) {
        if (labelAtCall !== currentLabelRef.current) return;
        if (isSharedDrivesUnavailable(err)) {
          setMembers({ kind: "unavailable" });
        } else {
          toast.error(`Could not remove member: ${errorMessage(err)}`);
        }
      }
    },
    [label, loadMembers],
  );

  if (!SHARED_DRIVES_ENABLED || !target) return null;

  return (
    <FramedDialog
      open
      onClose={() => setTarget(null)}
      title={`Share "${target.folderName}"`}
      icon={<Icons.Link className="size-4 text-white" />}
      maxWidth="max-w-[585px]"
    >
      <div className="font-geist">
        <div className="mb-5">
          <SegmentedControl<Tab>
            ariaLabel="Share drive sections"
            fullWidth
            value={tab}
            onChange={setTab}
            options={[
              { label: "Invite", value: "invite" },
              { label: "Members", value: "members" },
            ]}
          />
        </div>

        {tab === "invite" ? (
          <InviteTab
            state={invite}
            ttlSecs={ttlSecs}
            onTtlChange={setTtlSecs}
            onMint={() => void mintInvite()}
            onRetry={() => setInvite({ kind: "choosing" })}
            onClose={() => setTarget(null)}
          />
        ) : (
          <MembersTab state={members} onRemove={(ss58) => void removeMember(ss58)} />
        )}
      </div>
    </FramedDialog>
  );
}

function InviteTab({
  state,
  ttlSecs,
  onTtlChange,
  onMint,
  onRetry,
  onClose,
}: {
  state: InviteState;
  ttlSecs: number;
  onTtlChange: (secs: number) => void;
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
  return (
    <div>
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
          {neverExpires
            ? "Anyone with the link can join this drive — and read and change its files — for as long as the link exists. Share it only with people you trust."
            : "Anyone with the link can join this drive — and read and change its files — until the link expires. Share it only with people you trust."}
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
        <button
          type="button"
          onClick={() => void handleCopy()}
          title={copied ? "Copied!" : "Copy link"}
          aria-label="Copy link"
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-1 transition-colors",
            copied
              ? "border-success-90 bg-success-100 text-success-50 dark:border-success-50/60 dark:bg-success-50/10 dark:text-success-50"
              : cn(
                  "border-grey-80 bg-grey-90 text-grey-10 hover:bg-grey-80",
                  "dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#363636]",
                ),
          )}
        >
          {copied ? <Check className="size-4" /> : <Icons.Copy className="size-4" />}
        </button>
      </div>

      <p className="mb-6 text-xs text-grey-50 dark:text-grey-dark-600">
        {neverExpires
          ? "This link never expires — anyone who has it can join the drive. To revoke someone's access after they joined, remove them from the Members tab."
          : "Anyone with this link can join the drive until it expires. To revoke someone's access after they joined, remove them from the Members tab."}
      </p>

      <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={secondaryButtonClass}>
        Done
      </Button>
    </div>
  );
}

function MembersTab({
  state,
  onRemove,
}: {
  state: MembersState;
  onRemove: (memberSs58: string) => void;
}) {
  const view = getMembersView(state);

  if (view === "loading") {
    return (
      <p className="py-8 text-center text-sm text-grey-50 dark:text-grey-dark-600">Loading members…</p>
    );
  }

  if (view === "unavailable") {
    return (
      <p className="py-8 text-center text-sm text-grey-50 dark:text-grey-dark-600">
        Shared drives aren&apos;t available on your server yet.
      </p>
    );
  }

  if (view === "error") {
    return (
      <div className="mb-2 flex items-start gap-2 rounded-md border border-error-90 bg-error-100/40 px-3 py-2.5 dark:border-error-30/60 dark:bg-error-30/10">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-error-70" />
        <p className="break-words text-xs text-grey-50 dark:text-grey-dark-600">
          {state.kind === "error" ? state.message : "Couldn't load members"}
        </p>
      </div>
    );
  }

  if (view === "empty") {
    return (
      <p className="py-8 text-center text-sm text-grey-50 dark:text-grey-dark-600">
        No one has joined this drive yet. Mint an invite link from the Invite tab.
      </p>
    );
  }

  const members = state.kind === "ready" ? state.members : [];
  return (
    <div className="max-h-[320px] overflow-y-auto">
      {members.map((member) => (
        <MemberRow key={member.memberSs58} member={member} onRemove={onRemove} />
      ))}
    </div>
  );
}

function MemberRow({
  member,
  onRemove,
}: {
  member: DriveMemberInfo;
  onRemove: (memberSs58: string) => void;
}) {
  // Two-step inline confirm: the first click arms the row, the second
  // actually removes — the SharesPageClient treatment, without a nested
  // dialog inside a dialog.
  const [confirming, setConfirming] = useState(false);
  const joined = formatJoinedDate(member.createdAt);

  return (
    <div className="flex items-center justify-between gap-3 border-b border-grey-90 py-2.5 last:border-b-0 dark:border-white/10">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="size-[28px] shrink-0 overflow-hidden rounded-full">
          <Avatar name={member.memberSs58} size={28} variant="pixel" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-grey-10 dark:text-white" title={member.memberSs58}>
            {middleTruncate(member.memberSs58, 22)}
          </p>
          <p className="text-[11px] text-grey-50 dark:text-grey-dark-600">
            {member.role}
            {joined ? ` · Joined ${joined}` : ""}
          </p>
        </div>
      </div>

      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="auto"
            onClick={() => {
              setConfirming(false);
              onRemove(member.memberSs58);
            }}
            className="h-7 rounded-md border border-error-50/40 px-2 text-xs font-medium text-error-50 hover:bg-error-50/10"
          >
            Confirm remove
          </Button>
          <Button
            variant="ghost"
            size="auto"
            onClick={() => setConfirming(false)}
            className="h-7 rounded-md px-2 text-xs font-medium text-grey-50 hover:bg-grey-90 dark:text-grey-dark-600 dark:hover:bg-white/10"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="auto"
          onClick={() => setConfirming(true)}
          className="h-7 shrink-0 rounded-md border border-grey-80 px-2 text-xs font-medium text-grey-30 hover:bg-grey-90 dark:border-white/10 dark:text-grey-dark-600 dark:hover:bg-white/10"
        >
          Remove
        </Button>
      )}
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

const primaryButtonClass = cn(
  "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px]",
  "border-[#3167DD] bg-[#3167DD] text-white",
  "hover:bg-[#2454c4] hover:border-[#2454c4]",
  "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
);

const secondaryButtonClass = "h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]";

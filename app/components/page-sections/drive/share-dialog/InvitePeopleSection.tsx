"use client";

// "Invite people": one address, one role, one button. It only ever calls the
// email command (`POST /v1/drive-invites/email`), which binds the invite to
// the recipient, so nothing here can mint a link anybody else could use.
//
// The address is checked by Rust as it is typed (`check_invite_email`, the
// same rule the send applies), so the field says what is wrong before Send
// is pressed and can never accept what the send would refuse.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import Input from "@/components/ui/input";
import { Select } from "@/components/ui/select/Select";
import {
  checkInviteEmail,
  emailDriveInvite,
  emailInvitesAvailable,
  type DriveTarget,
  type InviteEmailCheck,
} from "@/app/lib/tauri/sharedDrives";
import { driveRoleDescription, driveRoleLabel } from "@/app/lib/shared-drives/roles";
import { UserPlus } from "lucide-react";
import { COMING_SOON_COPY, EMAIL_INVITE_ROLES } from "../shareDriveModalState";
import { InlineNotice } from "./InlineNotice";
import { SectionNoticeView } from "./SectionNoticeView";
import { noticeForError, type SectionNotice } from "./shareDialogState";

type EmailRole = (typeof EMAIL_INVITE_ROLES)[number];

const NOT_CHECKED: InviteEmailCheck = { valid: false };

export function InvitePeopleSection({
  label,
  pathPrefix,
  target,
  onSent,
  onUpgrade,
}: {
  label: string;
  /** Present for a folder; the folder rides on the email request. */
  pathPrefix: string | null;
  target?: DriveTarget;
  onSent: () => void;
  onUpgrade: () => void;
}) {
  const folder = pathPrefix !== null;
  // A drive keeps the Editor default every earlier build sent; a folder
  // starts at Viewer, since Editor on one folder may still be coming soon.
  const [role, setRole] = useState<EmailRole>(folder ? "reader" : "writer");
  const [email, setEmail] = useState("");
  const [check, setCheck] = useState<InviteEmailCheck>(NOT_CHECKED);
  // Say what is wrong with the address only once somebody has left the field
  // or pressed Send: a half-typed address is not a mistake yet.
  const [showCheck, setShowCheck] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<SectionNotice | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // The mail probe, as a hint only: the section is always offered, and a
  // known "no mail here" just says so before anyone types an address.
  const [mailKnownOff, setMailKnownOff] = useState(false);
  const checkSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    emailInvitesAvailable(label, target)
      .then((available) => {
        if (!cancelled) setMailKnownOff(!available);
      })
      .catch(() => {
        // Unknown stays unknown: sending is still the real answer.
      });
    return () => {
      cancelled = true;
    };
  }, [label, target]);

  const handleEmailChange = useCallback((next: string) => {
    setEmail(next);
    setSentTo(null);
    setNotice((n) => (n?.kind === "error" ? null : n));
    const seq = ++checkSeq.current;
    checkInviteEmail(next)
      .then((result) => {
        // Only the answer for what is in the field now.
        if (seq === checkSeq.current) setCheck(result);
      })
      .catch(() => {
        if (seq === checkSeq.current) setCheck(NOT_CHECKED);
      });
  }, []);

  const send = useCallback(
    async (asRole: EmailRole) => {
      setShowCheck(true);
      if (sending) return;
      // Enter can beat the as-you-type answer; ask once more before refusing.
      let verdict = check;
      if (!verdict.valid) {
        verdict = await checkInviteEmail(email).catch(() => NOT_CHECKED);
        setCheck(verdict);
        if (!verdict.valid) return;
      }
      const address = email.trim();
      setSending(true);
      setNotice(null);
      setSentTo(null);
      try {
        await emailDriveInvite(label, address, {
          role: asRole,
          target,
          ...(folder ? { pathPrefix: pathPrefix ?? "" } : {}),
        });
        // Ready for the next person: the dialog stays open.
        checkSeq.current++;
        setEmail("");
        setCheck(NOT_CHECKED);
        setShowCheck(false);
        setSentTo(address);
        onSent();
      } catch (err) {
        const next = noticeForError(err);
        if (next.kind === "comingSoon" && next.text === COMING_SOON_COPY.email) {
          setMailKnownOff(true);
        }
        setNotice(next);
      } finally {
        setSending(false);
      }
    },
    [check, sending, email, label, target, folder, pathPrefix, onSent],
  );

  const sendAsViewer = useCallback(() => {
    setRole("reader");
    void send("reader");
  }, [send]);

  const mailOff = mailKnownOff && notice === null;
  // Composing once the field holds anything; clearing it folds the row away.
  const composing = email.trim().length > 0;
  const blocked = sending || !check.valid || mailKnownOff;
  const invalidMessage = showCheck && !check.valid ? check.message : undefined;

  return (
    <section aria-labelledby="share-invite-people" className="@container">
      <h3
        id="share-invite-people"
        className="mb-2 text-sm font-medium text-grey-10 dark:text-white"
      >
        Invite people
      </h3>
      <form
        className="flex flex-col gap-2 @xs:flex-row @xs:items-start"
        onSubmit={(e) => {
          e.preventDefault();
          void send(role);
        }}
        noValidate
      >
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Email address"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="Add people by email"
            value={email}
            onChange={(e) => handleEmailChange(e.target.value)}
            onBlur={() => {
              if (email.trim()) setShowCheck(true);
            }}
            aria-invalid={invalidMessage ? true : undefined}
            aria-describedby={invalidMessage ? "share-invite-email-error" : undefined}
            startAdornment={<UserPlus className="size-4" aria-hidden />}
            wrapperClassName="min-h-[34px] items-center gap-2 px-3 py-1.5 shadow-none sm:min-h-[34px] sm:items-center dark:shadow-none"
            className="text-[13px] leading-5 tracking-normal sm:tracking-normal"
          />
        </div>
        {/* The role and the button appear only once there is an address to
            send to: at rest the section is one field, like any share sheet. */}
        {composing ? (
          <div className="flex gap-2">
            <Select
              ariaLabel="Invite role"
              value={role}
              onValueChange={(value) => {
                setRole(value as EmailRole);
                setNotice((n) => (n?.kind === "folderEditor" ? null : n));
              }}
              options={EMAIL_INVITE_ROLES.map((r) => ({
                label: driveRoleLabel(r),
                value: r,
                description: driveRoleDescription(r),
              }))}
              size="compact"
              minimal
              className="w-[96px] shrink-0"
            />
            <Button
              type="submit"
              variant="primary"
              size="auto"
              disabled={blocked}
              className="h-[34px] flex-1 whitespace-nowrap rounded-[8px] px-3.5 text-[13px] font-medium @xs:flex-none"
            >
              {sending ? "Sending…" : "Send invite"}
            </Button>
          </div>
        ) : null}
      </form>

      {invalidMessage ? (
        <p id="share-invite-email-error" className="mt-1.5 text-xs text-error-70">
          {invalidMessage}
        </p>
      ) : null}

      {composing ? (
        <p className="mt-2 text-xs text-grey-50 dark:text-grey-dark-600">
          They get their own invite that only works for them.
        </p>
      ) : null}

      {sentTo ? (
        <InlineNotice tone="success" className="mt-3">
          Invite sent to {sentTo}
        </InlineNotice>
      ) : null}
      {mailOff ? (
        <InlineNotice tone="info" className="mt-3">
          {COMING_SOON_COPY.email}
        </InlineNotice>
      ) : null}
      {notice ? (
        <SectionNoticeView
          notice={notice}
          viewOnlyLabel="Send as view only"
          onViewOnly={sendAsViewer}
          onUpgrade={onUpgrade}
          className="mt-3"
        />
      ) : null}
    </section>
  );
}

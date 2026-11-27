"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select/Select";
import { SettingsToggle } from "@/app/components/page-sections/settings/SettingsToggle";
import { shareLinkNotificationsEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import {
  canReceiveLinkEmails,
  getLinkVisitEmails,
  getNotificationPreferences,
  setLinkVisitEmails,
  setNotificationPreferences,
  type NotificationPreferences,
  type VisitEmails,
} from "@/app/lib/tauri/shareInsights";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/** The section's heading, and its accessible name. */
export const SECURE_LINK = "Secure link";

/**
 * The first-view email switch. It is the account's "First views" email from
 * Settings, so it says "a link", not "this link".
 */
export const FIRST_VIEW_EMAIL = "Email me when any link is first opened";

/** The per-link email setting's label, and its accessible name. */
export const LINK_VISIT_EMAILS = "Emails about this link";

/**
 * Why Every visit and First visit cannot be picked while the account's First
 * views email is off: the server sends both through that one switch.
 */
export const VISIT_EMAILS_NEED_FIRST_VIEWS = "Turn on First views in Settings to get these";

/**
 * Why Every visit and First visit cannot be picked on a link that does not
 * count views: there are no visits to email about. None stays, since it also
 * stops the link's NDA and refused viewer emails.
 */
export const VISIT_EMAILS_NEED_INSIGHTS = "Turn on Insights to get these";

const VISIT_EMAIL_OPTIONS: ReadonlyArray<{ value: VisitEmails; label: string }> = [
  { value: "every", label: "Every visit" },
  { value: "first", label: "First visit" },
  { value: "off", label: "None" },
];

/**
 * Shown in place of the link email switches for an account with no email
 * address (one that signs in with an access key).
 */
export const LINK_EMAILS_NEED_SIGN_IN = "To get an email when your links are opened, sign in with Google or Apple.";

/**
 * Who can open the link and for how long, in one place: access and password,
 * expiry, and the first-view email. Same grouping as the web app's share
 * dialog. Only a layout: each control inside keeps its own behaviour.
 */
export function SecureLinkSection({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section role="group" aria-label={SECURE_LINK} className={cn("flex flex-col gap-1.5", className)}>
      <p className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">{SECURE_LINK}</p>
      {children}
    </section>
  );
}

/**
 * Whether link emails can reach this account (Rust's
 * `share_can_receive_link_emails`), asked only while `enabled`. `null` while
 * asking and for good when Rust cannot tell, so nothing is shown then.
 */
export function useCanReceiveLinkEmails(enabled: boolean): boolean | null {
  const [canReceive, setCanReceive] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled || canReceive !== null) return;
    let alive = true;
    canReceiveLinkEmails()
      .then((v) => alive && setCanReceive(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, canReceive]);
  return canReceive;
}

/** The one line an account with no email sees instead of the switches. */
export function LinkEmailsNeedSignIn({ className }: { className?: string }) {
  return <p className={cn("text-xs text-grey-60 dark:text-grey-70", className)}>{LINK_EMAILS_NEED_SIGN_IN}</p>;
}

/**
 * The account's email preferences, read only while `enabled` (the link counts
 * views, without which no first-view email is sent). `null` until read, and
 * for good when the read fails, which is also what a server without these
 * emails answers: the switch is then simply not shown.
 */
function useNotificationPreferences(enabled: boolean) {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!enabled || prefs) return;
    let alive = true;
    getNotificationPreferences()
      .then((p) => alive && setPrefs(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, prefs]);

  // Shown as changed at once, put back if the server refuses, as in Settings.
  const setFirstViews = async (firstViews: boolean) => {
    if (!prefs) return;
    const before = prefs;
    const next = { ...prefs, firstViews };
    setPrefs(next);
    setSaving(true);
    try {
      await setNotificationPreferences(next);
    } catch (err) {
      setPrefs(before);
      toast.error(`Couldn't save that. ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };
  return { prefs, saving, setFirstViews };
}

/**
 * "Email me when any link is first opened": the account's first-view email,
 * which covers every link, so the label says so. Shown while the link counts views (`viewsCounted`) and the server sends
 * these emails. An account with no email address gets one line saying how to
 * get them instead, never a switch that cannot do anything.
 */
export function FirstViewEmailSwitch({ viewsCounted, shareToken }: { viewsCounted: boolean; shareToken?: string }) {
  const canReceive = useCanReceiveLinkEmails(viewsCounted);
  const { prefs, saving, setFirstViews } = useNotificationPreferences(viewsCounted && canReceive === true);
  if (!viewsCounted || canReceive === null) return null;
  if (!canReceive) return <LinkEmailsNeedSignIn className="mt-3" />;
  return (
    <>
      {prefs && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">{FIRST_VIEW_EMAIL}</span>
          <SettingsToggle
            ariaLabel={FIRST_VIEW_EMAIL}
            checked={prefs.firstViews}
            disabled={saving}
            onCheckedChange={(on) => void setFirstViews(on)}
          />
        </div>
      )}
      {/* Beside the account switch, so turning First views on or off here
          updates which of the link's choices can be picked at once. */}
      {shareToken && (
        <LinkVisitEmailsSelect
          shareToken={shareToken}
          viewsCounted={viewsCounted}
          firstViews={prefs ? prefs.firstViews : null}
        />
      )}
    </>
  );
}

/**
 * "Emails about this link": which visit emails the owner gets about this one
 * file link (every visit, the first only, or none, which also stops its
 * comment, return visit, NDA and refused viewer emails). Shown only while the
 * server has the setting (`share_link_notifications`) and the account can
 * get email, and only once Rust has read the link's value: a link the server
 * has no value for shows nothing. A change shows at once and is put back if
 * the server refuses it.
 *
 * On a link that does not count views (`viewsCounted` false) there is no
 * visit to email about, so Every visit and First visit are disabled with
 * the reason under them; None stays, since it also stops the link's NDA and
 * refused viewer emails. `firstViews` is the account's First views email.
 * While it is off, the server sends neither the first-view nor the
 * every-visit email, so those two are disabled the same way. `null` (not
 * read) disables nothing.
 *
 * `layout` is `stack` in the Share dialog and `list` (a bordered row) in the
 * side panel's Link settings.
 */
export function LinkVisitEmailsSelect({
  shareToken,
  viewsCounted,
  firstViews = null,
  layout = "stack",
}: {
  shareToken: string;
  viewsCounted: boolean;
  firstViews?: boolean | null;
  layout?: "stack" | "list";
}) {
  const offered = useAtomValue(shareLinkNotificationsEnabledAtom);
  const canReceive = useCanReceiveLinkEmails(offered);
  const enabled = offered && canReceive === true;
  const [visits, setVisits] = useState<VisitEmails | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getLinkVisitEmails(shareToken)
      .then((v) => alive && setVisits(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, shareToken]);

  if (!enabled || !visits) return null;

  const change = async (next: VisitEmails) => {
    const before = visits;
    setVisits(next);
    setSaving(true);
    try {
      await setLinkVisitEmails(shareToken, next);
    } catch (err) {
      setVisits(before);
      toast.error(`Couldn't save that. ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const list = layout === "list";
  // One reason per disabled choice: no views counted says more than the
  // account switch, which would not help while the link counts nothing.
  const reason = !viewsCounted ? VISIT_EMAILS_NEED_INSIGHTS : firstViews === false ? VISIT_EMAILS_NEED_FIRST_VIEWS : null;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3",
        list ? "rounded-[12px] border border-grey-80 px-3 py-2.5 dark:border-[#494949]" : "mt-3",
      )}
      data-testid="link-visit-emails"
    >
      <span
        className={cn(
          "font-medium",
          list ? "text-[13px] text-grey-10 dark:text-white" : "text-xs text-grey-30 dark:text-grey-dark-700",
        )}
      >
        {LINK_VISIT_EMAILS}
      </span>
      <div className="w-[132px] flex-shrink-0">
        <Select
          ariaLabel={LINK_VISIT_EMAILS}
          size="compact"
          value={visits}
          disabled={saving}
          onValueChange={(v) => void change(v as VisitEmails)}
          options={VISIT_EMAIL_OPTIONS.map(({ value, label }) => {
            const off = reason !== null && value !== "off";
            return {
              value,
              label,
              disabled: off,
              // Under the choice in the list (read out with it), and on hover.
              description: off && !viewsCounted ? VISIT_EMAILS_NEED_INSIGHTS : undefined,
              title: off ? (reason ?? undefined) : undefined,
            };
          })}
        />
      </div>
    </div>
  );
}

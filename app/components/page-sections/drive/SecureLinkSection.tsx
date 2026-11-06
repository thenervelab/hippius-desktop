"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { SettingsToggle } from "@/app/components/page-sections/settings/SettingsToggle";
import {
  getNotificationPreferences,
  setNotificationPreferences,
  type NotificationPreferences,
} from "@/app/lib/tauri/shareInsights";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/** The section's heading, and its accessible name. */
export const SECURE_LINK = "Secure link";

/**
 * The first-view email switch. It is the account's "First views" email from
 * Settings, so it says "a link", not "this link".
 */
export const FIRST_VIEW_EMAIL = "Email me when a link is first opened";

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
 * "Email me when a link is first opened": the account's first-view email,
 * shown while the link counts views (`viewsCounted`) and the server sends
 * these emails.
 */
export function FirstViewEmailSwitch({ viewsCounted }: { viewsCounted: boolean }) {
  const { prefs, saving, setFirstViews } = useNotificationPreferences(viewsCounted);
  if (!viewsCounted || !prefs) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">{FIRST_VIEW_EMAIL}</span>
      <SettingsToggle
        ariaLabel={FIRST_VIEW_EMAIL}
        checked={prefs.firstViews}
        disabled={saving}
        onCheckedChange={(on) => void setFirstViews(on)}
      />
    </div>
  );
}

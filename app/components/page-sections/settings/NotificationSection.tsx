"use client";

import React, { useState, useEffect } from "react";
import * as Switch from "@radix-ui/react-switch";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, Bell, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useNotificationPreferences } from "@/app/lib/hooks/useNotificationPreferences";
import { useSetAtom } from "jotai";
import {
  refreshEnabledTypesAtom,
  refreshNotificationsAtom,
} from "@/components/page-sections/notifications/notificationStore";
import useNotificationSettings, {
  type NotificationSettings as EmailSettings,
} from "@/lib/hooks/api/useNotificationSettings";
import { useWalletAuth } from "@/lib/wallet-auth-context";

const EMAIL_ITEMS: { key: keyof EmailSettings; label: string }[] = [
  { key: "low_credit_alerts", label: "Low credit balance alerts" },
  { key: "zero_balance_alerts", label: "Zero balance alerts" },
  { key: "marketing_emails", label: "Marketing emails & newsletter" },
];

const EMPTY_EMAIL: EmailSettings = {
  email_enabled: false,
  low_credit_alerts: false,
  zero_balance_alerts: false,
  file_status_updates: false,
  marketing_emails: false,
};

function CardShell({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[8px] border overflow-hidden bg-grey-light-300 border-grey-dark-100 dark:bg-black-primary-bg dark:border-black-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]">
      <div className="flex h-[46px] w-full items-center pl-[14px] pr-[10px]">
        <div className="flex items-center gap-1">
          {icon}
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            {label}
          </p>
        </div>
      </div>
      <div className="rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300">
        {children}
      </div>
    </div>
  );
}

function ToggleRow({
  checked,
  onCheckedChange,
  label,
  description,
  statusBadge = true,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description: string;
  statusBadge?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-4">
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="w-[2.5rem] h-[1.5rem] bg-grey-80 rounded-full relative data-[state=checked]:bg-primary-50 outline-none cursor-pointer border border-grey-80 data-[state=checked]:border-primary-50 transition-colors flex-shrink-0 mt-0.5"
      >
        <Switch.Thumb className="block w-[1.25rem] h-[1.25rem] bg-white rounded-full transition-transform duration-100 translate-x-0.5 will-change-transform data-[state=checked]:translate-x-[1.125rem]" />
      </Switch.Root>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-grey-10 dark:text-white">
            {label}
          </span>
          {statusBadge && (
            <span
              className={cn(
                "text-xs font-medium px-1.5 py-0.5 rounded border flex-shrink-0",
                checked
                  ? "bg-success-95 text-success-50 border-success-80"
                  : "bg-grey-95 text-grey-50 border-grey-80"
              )}
            >
              {checked ? "● On" : "● Off"}
            </span>
          )}
        </div>
        <p className="text-sm text-grey-60 dark:text-grey-70 mt-1">
          {description}
        </p>
      </div>
    </div>
  );
}

export default function NotificationSection() {
  const { preferences, savePreferences } = useNotificationPreferences();
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const refreshNotifications = useSetAtom(refreshNotificationsAtom);
  const [localPrefs, setLocalPrefs] = useState<Record<string, boolean>>({});

  const { oauthSession } = useWalletAuth();
  const { settings, updateSettings, isUpdating } = useNotificationSettings();
  const [localEmail, setLocalEmail] = useState<EmailSettings>(EMPTY_EMAIL);

  const [isSaving, setIsSaving] = useState(false);

  const isAccessKeyLogin = oauthSession?.provider === "mnemonic";
  const requiresOAuthLogin = isAccessKeyLogin || !oauthSession?.token;

  useEffect(() => {
    if (preferences.length > 0) {
      setLocalPrefs(
        preferences.reduce(
          (acc, p) => ({ ...acc, [p.id]: p.enabled }),
          {} as Record<string, boolean>
        )
      );
    }
  }, [preferences]);

  useEffect(() => {
    if (settings) setLocalEmail(settings);
  }, [settings]);

  const hasChanged =
    preferences.some((p) => localPrefs[p.id] !== p.enabled) ||
    (!requiresOAuthLogin &&
      settings != null &&
      (Object.keys(EMPTY_EMAIL) as (keyof EmailSettings)[]).some(
        (k) => localEmail[k] !== settings[k]
      ));

  const handleCancel = () => {
    setLocalPrefs(
      preferences.reduce(
        (acc, p) => ({ ...acc, [p.id]: p.enabled }),
        {} as Record<string, boolean>
      )
    );
    if (settings) setLocalEmail(settings);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const prefsOk = await savePreferences(localPrefs);
      if (!prefsOk) {
        toast.error("Failed to save notification preferences");
        return;
      }
      if (!requiresOAuthLogin) {
        await updateSettings(localEmail);
      }
      await refreshEnabledTypes();
      await refreshNotifications();
      toast.success("Notification settings saved");
    } catch {
      toast.error("Failed to save notification settings");
    } finally {
      setIsSaving(false);
    }
  };

  const busy = isSaving || isUpdating;

  return (
    <div className="flex flex-col gap-4">
      {/* Notification Preferences card */}
      <CardShell
        icon={
          <Bell className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
        }
        label="Notification Preferences"
      >
        {preferences.length === 0 ? (
          <div className="px-4 py-6 flex flex-col gap-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-12 rounded-lg bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
              />
            ))}
          </div>
        ) : (
          preferences.map((item, idx) => (
            <React.Fragment key={item.id}>
              {idx > 0 && (
                <div className="h-px bg-grey-80 dark:bg-white/10 mx-4" />
              )}
              <ToggleRow
                checked={localPrefs[item.id] ?? false}
                onCheckedChange={(checked) =>
                  setLocalPrefs((prev) => ({ ...prev, [item.id]: checked }))
                }
                label={item.label}
                description={item.description}
              />
            </React.Fragment>
          ))
        )}
      </CardShell>

      {/* Email Notification card */}
      <CardShell
        icon={
          <Mail className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
        }
        label="Email Notification"
      >
        {requiresOAuthLogin ? (
          <p className="px-4 py-4 text-sm text-grey-60 dark:text-grey-70">
            Sign in with Google, GitHub, or Email to manage email notifications.
          </p>
        ) : (
          <>
            <ToggleRow
              checked={localEmail.email_enabled}
              onCheckedChange={(checked) =>
                setLocalEmail((prev) => ({ ...prev, email_enabled: checked }))
              }
              label="Receive Email Notifications"
              description="Get emails on everything from us"
              statusBadge={false}
            />
            <div className="h-px bg-grey-80 dark:bg-white/10 mx-4" />
            <div className="px-4 py-3 flex flex-col gap-3">
              {EMAIL_ITEMS.map(({ key, label }) => (
                <div
                  key={key}
                  className={cn(
                    "flex items-center gap-2",
                    !localEmail.email_enabled && "opacity-40 pointer-events-none"
                  )}
                >
                  <Checkbox.Root
                    id={key}
                    checked={localEmail[key] as boolean}
                    onCheckedChange={(checked) =>
                      setLocalEmail((prev) => ({
                        ...prev,
                        [key]: checked === true,
                      }))
                    }
                    disabled={!localEmail.email_enabled}
                    className="flex h-4 w-4 items-center justify-center rounded bg-white border border-grey-80 outline-none data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors"
                  >
                    <Checkbox.Indicator>
                      <Check className="h-3 w-3 text-white" />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                  <label
                    htmlFor={key}
                    className={cn(
                      "text-sm font-medium text-grey-50 dark:text-grey-60 select-none",
                      localEmail.email_enabled
                        ? "cursor-pointer"
                        : "cursor-not-allowed"
                    )}
                  >
                    {label}
                  </label>
                </div>
              ))}
            </div>
          </>
        )}
      </CardShell>

      {/* Action buttons */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy || !hasChanged}
          className="px-4 py-2 text-sm font-medium text-grey-40 dark:text-grey-60 border border-grey-80 dark:border-white/10 rounded-lg hover:bg-grey-98 dark:hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !hasChanged}
          className="px-4 py-2 text-sm font-medium text-white bg-primary-50 rounded-lg hover:bg-primary-40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
}

"use client";

import React, { useState, useEffect } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Button } from "@/components/ui/button";
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
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[8px] border overflow-hidden bg-grey-light-300 border-grey-dark-100 dark:bg-black-primary-bg dark:border-black-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]">
      <div className="flex h-[46px] w-full items-center pl-[14px] pr-[10px]">
        <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
          {label}
        </p>
      </div>
      <div className="rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300">
        {children}
      </div>
    </div>
  );
}

// Square checkbox — solid fill, no checkmark
function SquareCheck({
  id,
  checked,
  onCheckedChange,
  disabled,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Checkbox.Root
      id={id}
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      disabled={disabled}
      className={cn(
        "flex-shrink-0 outline-none cursor-pointer transition-colors",
        checked ? "bg-[#3167DD]" : "bg-[#F0F0F0] dark:bg-white/10"
      )}
      style={{ width: 18, height: 18, borderRadius: 5 }}
    />
  );
}

// Horizontal mini-toggle: pill slides left ↔ right via alignItems on a column flex container
// Outer: 22px wide × auto height (~17px). alignItems flex-start = pill left, flex-end = pill right.
function EmailToggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex-shrink-0 outline-none cursor-pointer border-[1.2px] transition-all duration-150",
        checked
          ? "border-[#1F51BE] opacity-100"
          : "border-black dark:border-white opacity-30"
      )}
      style={{
        display: "flex",
        width: 22,
        padding: 2,
        flexDirection: "column",
        alignItems: checked ? "flex-end" : "flex-start",
        borderRadius: 4,
        background: "transparent",
        boxSizing: "border-box",
      }}
    >
      <div
        className={cn(
          "transition-colors",
          checked ? "bg-[#1F51BE]" : "bg-black dark:bg-white"
        )}
        style={{
          width: 8.571,
          height: 12.857,
          borderRadius: 2,
          flexShrink: 0,
        }}
      />
    </button>
  );
}

function ToggleRow({
  checked,
  onCheckedChange,
  label,
  description,
  id,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description: string;
  id?: string;
}) {
  return (
    <div className="px-4 py-3">
      {/* Top row: checkbox + label + badge all vertically centered together */}
      <div className="flex items-center gap-2 flex-wrap">
        <SquareCheck id={id} checked={checked} onCheckedChange={onCheckedChange} />
        <label htmlFor={id} className="text-sm font-medium text-grey-10 dark:text-white cursor-pointer">
          {label}
        </label>
        {checked ? (
          <span className="flex items-center gap-[5px] px-[8.8px] py-[5px] rounded-full bg-[rgba(4,200,112,0.2)] flex-shrink-0">
            <svg width="12" height="12" viewBox="0 0 9.5 9.5" fill="none" className="flex-shrink-0">
              <circle cx="4.75" cy="4.75" r="4.75" fill="#04C870" fillOpacity="0.2" />
              <circle cx="4.75" cy="4.75" r="2.375" fill="#04C870" />
            </svg>
            <span className="text-[10px] font-semibold leading-none tracking-[-0.2px]" style={{ color: "#04c870" }}>On</span>
          </span>
        ) : (
          <span className="flex items-center gap-[5px] px-[8.8px] py-[5px] rounded-full bg-[#f0f0f0] dark:bg-white/10 flex-shrink-0 text-[#b6b6b6] dark:text-grey-dark-500">
            <svg width="12" height="12" viewBox="0 0 9.5 9.5" fill="none" className="flex-shrink-0">
              <circle cx="4.75" cy="4.75" r="4.75" fill="currentColor" fillOpacity="0.2" />
              <circle cx="4.75" cy="4.75" r="2.375" fill="currentColor" />
            </svg>
            <span className="text-[10px] font-semibold leading-none tracking-[-0.2px]">Off</span>
          </span>
        )}
      </div>
      {/* Description sits below, indented to align with the label (18px checkbox + 12px gap) */}
      <p className="text-sm text-grey-60 dark:text-grey-70 mt-1 pl-[30px]">{description}</p>
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
      {/* Notification Preferences card — no separators between rows */}
      <CardShell label="Notification Preferences">
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
          preferences.map((item) => (
            <ToggleRow
              key={item.id}
              id={`pref-${item.id}`}
              checked={localPrefs[item.id] ?? false}
              onCheckedChange={(checked) =>
                setLocalPrefs((prev) => ({ ...prev, [item.id]: checked }))
              }
              label={item.label}
              description={item.description}
            />
          ))
        )}
      </CardShell>

      {/* Email Notification card */}
      <CardShell label="Email Notification">
        {requiresOAuthLogin ? (
          <p className="px-4 py-4 text-sm text-grey-60 dark:text-grey-70">
            Sign in with Google, GitHub, or Email to manage email notifications.
          </p>
        ) : (
          <>
            {/* Master toggle row */}
            <div className="flex items-start gap-3 px-4 py-3">
              <EmailToggle
                checked={localEmail.email_enabled}
                onCheckedChange={(checked) =>
                  setLocalEmail((prev) => ({ ...prev, email_enabled: checked }))
                }
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-grey-10 dark:text-white">
                  Receive Email Notifications
                </p>
                <p className="text-sm text-grey-60 dark:text-grey-70 mt-1">
                  Get emails on everything from us
                </p>

                {/* Sub-items aligned with text column above (no extra left padding needed) */}
                <div
                  className={cn(
                    "mt-3 flex flex-col gap-4",
                    !localEmail.email_enabled && "opacity-40 pointer-events-none"
                  )}
                >
                  {EMAIL_ITEMS.map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-2">
                      <SquareCheck
                        id={key}
                        checked={localEmail[key] as boolean}
                        onCheckedChange={(checked) =>
                          setLocalEmail((prev) => ({ ...prev, [key]: checked }))
                        }
                        disabled={!localEmail.email_enabled}
                      />
                      <label
                        htmlFor={key}
                        className={cn(
                          "text-sm font-medium text-grey-50 dark:text-grey-60 select-none",
                          localEmail.email_enabled ? "cursor-pointer" : "cursor-not-allowed"
                        )}
                      >
                        {label}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </CardShell>

      {/* Action buttons */}
      <div className="flex items-center gap-3">
        <Button
          variant="defaultStable"
          size="sm"
          onClick={handleCancel}
          disabled={busy || !hasChanged}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={busy || !hasChanged}
          loading={busy}
        >
          {busy ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}

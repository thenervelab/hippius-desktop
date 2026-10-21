"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Select } from "@/components/ui/select/Select";
import {
  getNotificationPreferences,
  setNotificationPreferences,
  type Digest,
  type NotificationPreferences,
} from "@/app/lib/tauri/shareInsights";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { SettingsCard } from "./SettingsCard";
import { SettingsToggle } from "./SettingsToggle";

const DIGEST_OPTIONS: ReadonlyArray<{ value: Digest; label: string }> = [
  { value: "weekly", label: "Weekly" },
  { value: "daily", label: "Daily" },
  { value: "off", label: "Off" },
];

/**
 * The emails about share links (the same three the console offers): a
 * link's first views, new comments, and a summary. Each change is saved at
 * once, and put back if the server refuses it. Shown only when the server
 * sends these emails (`share_notifications`).
 */
export default function ShareLinkEmailsSetting() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    getNotificationPreferences()
      .then((p) => alive && setPrefs(p))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const change = async (patch: Partial<NotificationPreferences>) => {
    if (!prefs) return;
    const before = prefs;
    const next = { ...prefs, ...patch };
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

  return (
    <SettingsCard label="Emails about your links">
      {failed ? (
        <p className="px-4 py-4 text-sm text-grey-60 dark:text-grey-70">
          Couldn&apos;t load these settings right now.
        </p>
      ) : !prefs ? (
        <div className="px-4 py-4">
          <div className="h-12 animate-pulse rounded-lg bg-grey-light-700 dark:bg-grey-dark-200" />
        </div>
      ) : (
        <div className="flex flex-col">
          <Row
            title="First views"
            description="An email when one of your links is opened for the first time."
          >
            <SettingsToggle
              ariaLabel="First views"
              checked={prefs.firstViews}
              disabled={saving}
              onCheckedChange={(firstViews) => void change({ firstViews })}
            />
          </Row>
          <Row
            title="New comments"
            description="An email when people comment on your links. Comments are encrypted, so it says how many, not what they say."
          >
            <SettingsToggle
              ariaLabel="New comments"
              checked={prefs.comments}
              disabled={saving}
              onCheckedChange={(comments) => void change({ comments })}
            />
          </Row>
          <Row title="Summary" description="Views and comments across all your links.">
            <div className="w-[120px]">
              <Select
                ariaLabel="Summary"
                value={prefs.digest}
                disabled={saving}
                onValueChange={(digest) => void change({ digest: digest as Digest })}
                options={DIGEST_OPTIONS.map(({ value, label }) => ({ value, label }))}
              />
            </div>
          </Row>
        </div>
      )}
    </SettingsCard>
  );
}

function Row({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-grey-10 dark:text-white">{title}</p>
        <p className="mt-1 text-sm text-grey-60 dark:text-grey-70">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

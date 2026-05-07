"use client";

import React, { useState, useEffect } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check, ArrowRight } from "lucide-react";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button/ButtonV2";
import { toast } from "sonner";
import { useNotificationPreferences } from "@/app/lib/hooks/useNotificationPreferences";
import { useSetAtom } from "jotai";
import {
  refreshEnabledTypesAtom,
  refreshNotificationsAtom,
} from "@/components/page-sections/notifications/notificationStore";

interface NotificationsSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const NotificationsSettingsDialog: React.FC<NotificationsSettingsDialogProps> = ({
  open,
  onClose,
}) => {
  const { preferences, savePreferences } = useNotificationPreferences();
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const refreshNotifications = useSetAtom(refreshNotificationsAtom);

  useEffect(() => {
    if (preferences.length > 0) {
      const initial = preferences.reduce(
        (acc, item) => ({ ...acc, [item.id]: item.enabled }),
        {} as Record<string, boolean>
      );
      setCheckedItems(initial);
    }
  }, [preferences]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const success = await savePreferences(checkedItems);
      if (success) {
        await refreshEnabledTypes();
        await refreshNotifications();
        toast.success("Notification preferences saved");
        onClose();
      } else {
        toast.error("Failed to save notification preferences");
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <FramedDialog
      open={open}
      onClose={onClose}
      title="Notifications Settings"
      icon={<Icons.Notification className="size-5 text-white" />}
      iconBgClassName="bg-primary-50 dark:bg-primary-brand-dark"
      borderClassName="bg-primary-50 dark:bg-primary-brand-dark"
      maxWidth="max-w-[690px]"
    >
      <p className="text-[14px] text-grey-50 dark:text-grey-dark-700 text-center leading-[1.5] mb-6 -mt-2">
        Choose which updates you&apos;d like to receive in your inbox.
        You&apos;re in control, check only the notifications that matter to you.
      </p>

      {/* Preference rows */}
      <div className="flex flex-col gap-3 mb-6">
        {preferences.map((item) => (
          <label
            key={item.id}
            htmlFor={item.id}
            className="flex items-start gap-3 cursor-pointer rounded-lg border border-grey-dark-100 dark:border-black-300 bg-grey-light-200 dark:bg-black-400 px-4 py-3 hover:bg-grey-light-300 dark:hover:bg-black-300 transition-colors"
          >
            <Checkbox.Root
              id={item.id}
              className="mt-0.5 size-4 rounded border border-grey-70 dark:border-black-300 flex items-center justify-center bg-white dark:bg-black-300 data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 dark:data-[state=checked]:bg-primary-brand-dark dark:data-[state=checked]:border-primary-brand-dark shrink-0 transition-colors"
              checked={checkedItems[item.id] ?? false}
              onCheckedChange={() =>
                setCheckedItems((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
              }
            >
              <Checkbox.Indicator>
                <Check className="size-2.5 text-white" />
              </Checkbox.Indicator>
            </Checkbox.Root>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[14px] font-medium text-grey-10 dark:text-white">
                  {item.label}
                </span>
              </div>
              <p className="text-[12px] text-grey-50 dark:text-grey-dark-700 leading-[1.4]">
                {item.description}
              </p>
            </div>
          </label>
        ))}
      </div>

      {/* Actions */}
      <Button
        variant="primary"
        size="noStyle"
        onClick={handleSave}
        disabled={isSaving}
        className="w-full h-[52px] text-[16px] font-medium flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {isSaving ? "Saving..." : "Save Changes"}
        {!isSaving && <ArrowRight className="size-4" />}
      </Button>

      <Button
        variant="default"
        size="noStyle"
        onClick={onClose}
        className="mt-3 w-full h-[52px] text-[16px] font-normal"
      >
        Cancel
      </Button>
    </FramedDialog>
  );
};

export default NotificationsSettingsDialog;

"use client";

import React, { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import DialogContainer from "@/components/ui/DialogContainer";
import { Icons } from "@/components/ui";
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
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit">
        <Dialog.Title className="sr-only">Notifications Settings</Dialog.Title>

        <div className="flex flex-col items-center px-6 pt-8 pb-6">
          {/* Bell icon */}
          <div className="size-12 rounded-full bg-primary-50 flex items-center justify-center mb-4">
            <Icons.Notification className="size-6 text-white" />
          </div>

          <h2 className="text-xl font-semibold text-grey-10 text-center">
            Notifications Settings
          </h2>
          <p className="text-sm text-grey-50 text-center mt-2 leading-5">
            Choose which updates you&apos;d like to receive in your inbox.
            You&apos;re in control—check only the notifications that matter to you.
          </p>

          {/* Preference checkboxes */}
          <div className="w-full mt-6 space-y-4">
            {preferences.map((item) => (
              <div key={item.id} className="flex items-start gap-3">
                <Checkbox.Root
                  id={item.id}
                  className="mt-0.5 h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-95 data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 flex-shrink-0"
                  checked={checkedItems[item.id] ?? false}
                  onCheckedChange={() =>
                    setCheckedItems((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                  }
                >
                  <Checkbox.Indicator>
                    <Check className="h-3 w-3 text-white" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <label htmlFor={item.id} className="flex-1 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-grey-10">{item.label}</span>
                    <span className="text-[0.625rem] font-medium px-1.5 py-0.5 rounded bg-success-90 text-success-40 leading-none">
                      Public
                    </span>
                  </div>
                  <p className="text-xs text-grey-50 mt-0.5 leading-[1.125rem]">
                    {item.description}
                  </p>
                </label>
              </div>
            ))}
          </div>

          {/* Actions */}
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="mt-6 w-full h-11 rounded-lg bg-primary-50 hover:bg-primary-40 active:bg-primary-30 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isSaving ? "Saving..." : "Save Changes"}
            {!isSaving && <Icons.ArrowRight className="size-4" />}
          </button>

          <button
            onClick={onClose}
            className="mt-3 w-full h-10 rounded-lg text-grey-40 text-sm font-medium hover:bg-grey-95 transition-colors"
          >
            Cancel
          </button>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default NotificationsSettingsDialog;

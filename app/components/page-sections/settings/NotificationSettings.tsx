import React, { useState, useEffect } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { CardButton, Icons, RevealTextLine } from "@/components/ui";
import SectionHeader from "./SectionHeader";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";
import { useNotificationPreferences } from "@/app/lib/hooks/useNotificationPreferences";
import { useSetAtom } from "jotai";
import {
  refreshEnabledTypesAtom,
  refreshNotificationsAtom,
} from "@/components/page-sections/notifications/notificationStore";

const NotificationSettings: React.FC = () => {
  const { preferences, savePreferences } = useNotificationPreferences();
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const refreshNotifications = useSetAtom(refreshNotificationsAtom);

  // Update local state when preferences load
  useEffect(() => {
    if (preferences.length > 0) {
      const initialState = preferences.reduce(
        (acc, item) => ({ ...acc, [item.id]: item.enabled }),
        {}
      );
      setCheckedItems(initialState);
    }
  }, [preferences]);

  const handleCheckboxChange = (id: string) => {
    setCheckedItems((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const handleSelectAll = () => {
    const allSelected = preferences.reduce(
      (acc, item) => ({ ...acc, [item.id]: true }),
      {}
    );
    setCheckedItems(allSelected);
  };

  const handleSelectNone = () => {
    const noneSelected = preferences.reduce(
      (acc, item) => ({ ...acc, [item.id]: false }),
      {}
    );
    setCheckedItems(noneSelected);
  };

  // Check if preferences have changed from their original values
  const hasChanged = preferences.length > 0 && preferences.some(
    (item) => checkedItems[item.id] !== item.enabled
  );

  const handleSaveChanges = async () => {
    setIsSaving(true);
    try {
      const success = await savePreferences(checkedItems);
      if (success) {
        await refreshEnabledTypes();
        await refreshNotifications();
        toast.success("Notification preferences saved successfully");
      } else {
        toast.error("Failed to save notification preferences");
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 w-full">
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className="flex flex-col w-full border broder-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover"
          >
            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <div className="w-full flex justify-between gap-4">
                <SectionHeader
                  Icon={Icons.Notification}
                  title="Notification Preferences"
                  subtitle="Choose which updates you'd like to receive in your inbox. You're in control—check only the notifications that matter to you."
                  info="Customize which events trigger notifications to stay informed about activity relevant to you. These settings control in-app notifications that appear within the application. Your preferences can be updated anytime."
                  learnMoreUrl="https://docs.hippius.com/use/desktop/settings#notifications"
                />
                <CardButton
                  className="max-w-[10rem] h-[2.625rem] shrink-0"
                  variant="dialog"
                  disabled={isSaving || !hasChanged}
                  onClick={handleSaveChanges}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex items-center text-base leading-6 font-medium">
                      {isSaving ? "Saving..." : "Save"}
                    </span>
                  </div>
                </CardButton>
              </div>
            </RevealTextLine>

            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <div className="mt-4 flex">
                <button
                  onClick={handleSelectAll}
                  className="text-primary-50 hover:text-primary-40 text-sm font-medium"
                >
                  Select All
                </button>
                <div className="w-[0.125rem] bg-grey-80 mx-4"></div>

                <button
                  onClick={handleSelectNone}
                  className="text-primary-50 hover:text-primary-40 text-sm font-medium"
                >
                  Select none
                </button>
              </div>
            </RevealTextLine>

            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <div className="mt-4 space-y-4">
                {preferences.map((item) => (
                  <div key={item.id} className="flex items-start">
                    <Checkbox.Root
                      className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-90 my-[0.1875rem] data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50"
                      checked={checkedItems[item.id] ?? false}
                      onCheckedChange={() => handleCheckboxChange(item.id)}
                      id={item.id}
                    >
                      <Checkbox.Indicator>
                        <Check className="h-3.5 w-3.5 text-white" />
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                    <div className="ml-2">
                      <label
                        htmlFor={item.id}
                        className="text-base font-medium text-grey-10 leading-[1.375rem]"
                      >
                        {item.label}
                      </label>
                      <p className="text-sm text-grey-50 mt-1">
                        {item.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </RevealTextLine>
          </div>
        )}
      </InView>
    </div>
  );
};

export default NotificationSettings;

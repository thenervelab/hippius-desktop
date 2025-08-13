import React, { useState, useEffect } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { CardButton, Icons, RevealTextLine } from "../../ui";
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

  const handleSaveChanges = async () => {
    const success = await savePreferences(checkedItems);
    if (success) {
      await refreshEnabledTypes();
      await refreshNotifications();

      toast.success("Notification preferences saved successfully");
    } else {
      toast.error("Failed to save notification preferences");
    }
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex flex-col w-full border broder-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover"
        >
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <SectionHeader
              Icon={Icons.Notification}
              title="Notification Preferences"
              subtitle="Choose which updates you'd like to receive in your inbox. You're in control—check only the notifications that matter to you."
              info="Customize which events trigger notifications to stay informed about activity relevant to you. Your preferences can be updated anytime."
            />
          </RevealTextLine>

          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <div className="mt-12 flex">
              <button
                onClick={handleSelectAll}
                className="text-primary-50 hover:text-primary-40 text-sm font-medium"
              >
                Select All
              </button>
              <div className="w-[2px] bg-grey-80 mx-4"></div>

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
                    className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-90 my-[3px] data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50"
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
                      className="text-base font-medium text-grey-10 leading-[22px]"
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

          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <div className="flex gap-4 mt-8 self-start">
              <CardButton
                className="max-w-[160px] h-[48px]"
                variant="dialog"
                onClick={handleSaveChanges}
              >
                <div className="flex items-center gap-2">
                  <span className="flex items-center text-lg leading-6 font-medium">
                    Save
                  </span>
                </div>
              </CardButton>
            </div>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default NotificationSettings;

import React, { useState } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { CardButton, Icons, RevealTextLine } from "../../ui";
import SectionHeader from "./SectionHeader";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";

type NotificationType = {
  id: string;
  label: string;
  description: string;
};

const NOTIFICATION_TYPES: NotificationType[] = [
  {
    id: "credits",
    label: "Credits",
    description:
      "Sends an alert when fresh credits land in your account or when your balance falls near zero, giving you time to top up before uploads pause."
  },
  {
    id: "files",
    label: "Files",
    description:
      "Pings you the moment a file sync completes, confirming your data is stored safely and ready whenever you need it."
  }
];

const NotificationSettings: React.FC = () => {
  const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>(
    NOTIFICATION_TYPES.reduce((acc, item) => ({ ...acc, [item.id]: false }), {})
  );

  const handleCheckboxChange = (id: string) => {
    setCheckedItems((prev) => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const handleSelectAll = () => {
    const allSelected = NOTIFICATION_TYPES.reduce(
      (acc, item) => ({ ...acc, [item.id]: true }),
      {}
    );
    setCheckedItems(allSelected);
  };

  const handleSelectNone = () => {
    const noneSelected = NOTIFICATION_TYPES.reduce(
      (acc, item) => ({ ...acc, [item.id]: false }),
      {}
    );
    setCheckedItems(noneSelected);
  };

  const handleSaveChanges = () => {
    // Here you would implement saving these preferences to your backend
    toast.success("Notification preferences saved successfully");
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex flex-col w-full border broder-grey-80 rounded-lg p-4"
        >
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <SectionHeader
              Icon={Icons.Notification}
              title="Email Notification Preferences"
              subtitle="Choose which updates you'd like to receive in your inbox. You're in control—check only the notifications that matter to you."
              iconSize="small"
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
              {NOTIFICATION_TYPES.map((item) => (
                <div key={item.id} className="flex items-start">
                  <Checkbox.Root
                    className="h-4 w-4 rounded border border-grey-70 flex items-center justify-center bg-grey-90 my-[3px] data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50"
                    checked={checkedItems[item.id]}
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
                className="max-w-[160px] h-[60px]"
                variant="dialog"
                onClick={handleSaveChanges}
              >
                <div className="flex items-center gap-2">
                  <span className="flex items-center text-lg leading-6 font-medium">
                    Save Changes
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

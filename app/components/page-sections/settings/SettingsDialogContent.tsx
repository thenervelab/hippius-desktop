import React, { useState } from "react";
import { Icons, RevealTextLine } from "../../ui";
import TabList, { TabOption } from "../../ui/tabs/tab-list";
import ChangePasscode from "./ChangePasscode";
import ExportEncryptedSeed from "./ExportEncryptedSeed";
import { InView } from "react-intersection-observer";
import AccountActionButtons from "./AccountActionButtons";
import SubAccounts from "./sub-accounts";
import NotificationSettings from "./NotificationSettings";

const SettingsDialogContent: React.FC = () => {
  const [activeTab, setActiveTab] = useState("Change Passcode");

  const tabs: TabOption[] = [
    {
      tabName: "Change Passcode",
      icon: <Icons.WalletAdd className="size-4" />
    },
    {
      tabName: "Sub Accounts",
      icon: <Icons.KeySquare className="size-4" />
    },
    {
      tabName: "Notifications",
      icon: <Icons.Notification className="size-4" />
    },
    {
      tabName: "Remove Account",
      icon: <Icons.Trash className="size-4" />
    }
  ];

  return (
    <div className="flex h-full w-full">
      <div className=" mr-8">
        <TabList
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          className=" flex-col"
          width="min-w-[168px]"
          isJustifyStart
        />
      </div>

      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            className="flex flex-col  animate-in fade-in duration-300 gap-8 w-full shadow-menu rounded-lg bg-white p-4 h-max mb-4"
            ref={ref}
          >
            {activeTab === "Change Passcode" && (
              <>
                <div className="flex gap-[18px] w-full">
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    parentClassName="w-[70.4%]"
                    className="delay-300 w-full"
                  >
                    <ChangePasscode />
                  </RevealTextLine>
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    parentClassName="w-[29.6%]"
                    className="delay-300 w-full"
                  >
                    <ExportEncryptedSeed />
                  </RevealTextLine>
                </div>
              </>
            )}

            {activeTab === "Sub Accounts" && (
              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 w-full"
              >
                <SubAccounts />
              </RevealTextLine>
            )}

            {activeTab === "Notifications" && (
              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 w-full"
              >
                <NotificationSettings />
              </RevealTextLine>
            )}

            {activeTab === "Remove Account" && (
              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 w-full"
              >
                <AccountActionButtons />
              </RevealTextLine>
            )}
          </div>
        )}
      </InView>
    </div>
  );
};

export default SettingsDialogContent;

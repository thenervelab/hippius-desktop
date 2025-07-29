import React, { useEffect } from "react";
import { Icons, RevealTextLine } from "../../ui";
import TabList, { TabOption } from "../../ui/tabs/tab-list";
import ChangePasscode from "./change-passcode";
import BackupAppData from "./BackupAppData";
import { InView } from "react-intersection-observer";
import ResetAppData from "./ResetAppData";
import UpdateSyncFolder from "./UpdateSyncFolder";
import SubAccounts from "./sub-accounts";
import NotificationSettings from "./NotificationSettings";
import { useAtom } from "jotai";
import { activeSettingsTabAtom } from "@/app/components/sidebar/sideBarAtoms";
import { useSetAtom } from "jotai";
import { refreshEnabledTypesAtom } from "@/components/page-sections/notifications/notificationStore";
import EncryptionKey from "./encryption-key";

const SettingsDialogContent: React.FC = () => {
  const [activeTab, setActiveTab] = useAtom(activeSettingsTabAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);

  // Refresh notification types when the settings dialog shows the notifications tab
  useEffect(() => {
    if (activeTab === "Notifications") {
      refreshEnabledTypes();
    }
  }, [activeTab, refreshEnabledTypes]);

  const tabs: TabOption[] = [
    {
      tabName: "File Settings",
      icon: <Icons.File2 className="size-4" />
    },
    {
      tabName: "Change Passcode",
      icon: <Icons.WalletAdd className="size-4" />
    },
    {
      tabName: "Sub Accounts",
      icon: <Icons.KeySquare className="size-4" />
    },
    {
      tabName: "Encryption Key",
      icon: <Icons.Key className="size-4" />
    },
    {
      tabName: "Notifications",
      icon: <Icons.Notification className="size-4" />
    },
    {
      tabName: "Backup App Data",
      icon: <Icons.Wallet className="size-4" />
    },
    {
      tabName: "Reset App Data",
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
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                >
                  <ChangePasscode />
                </RevealTextLine>
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

            {activeTab === "Reset App Data" && (
              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 w-full"
              >
                <ResetAppData />
              </RevealTextLine>
            )}

            {activeTab === "File Settings" && (
              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 w-full flex"
              >
                <UpdateSyncFolder />
              </RevealTextLine>
            )}
            {activeTab === "Backup App Data" && (
              <>
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                >
                  <BackupAppData />
                </RevealTextLine>
              </>
            )}

            {activeTab === "Encryption Key" && (
              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 w-full flex"
              >
                <EncryptionKey />
              </RevealTextLine>
            )}
          </div>
        )}
      </InView>
    </div>
  );
};

export default SettingsDialogContent;

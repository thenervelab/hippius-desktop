import React, { useEffect } from "react";
import { Icons, RevealTextLine } from "@/components/ui";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import { InView } from "react-intersection-observer";
import UpdateSyncFolder from "./UpdateSyncFolder";
import APIKeys from "./api-keys";
import NotificationSettings from "./NotificationSettings";
import { useAtom } from "jotai";
import { activeSettingsTabAtom } from "@/app/components/sidebar/sideBarAtoms";
import { useSetAtom } from "jotai";
import { refreshEnabledTypesAtom } from "@/components/page-sections/notifications/notificationStore";
import CustomizeRPC from "./CustomizeRPC";
import FileDeletionBehaviour from "./FileDeletionBehaviour";
import OAuthTokenSection from "./OAuthTokenSection";
import EmailNotificationSection from "./EmailNotificationSection";

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
      icon: <Icons.File2 className="size-4" />,
    },
    {
      tabName: "Master Token",
      icon: <Icons.Key className="size-4" />,
    },
    {
      tabName: "Notifications",
      icon: <Icons.Notification className="size-4" />,
    },
    {
      tabName: "Customize RPC",
      icon: <Icons.Box className="size-4" />,
    },
  ];

  return (
    <div className="flex h-full w-full">
      <div className="mt-[18px] mr-8">
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
            className="flex flex-col animate-in fade-in duration-300 gap-8 w-full h-max mb-4 pt-[18px]"
            ref={ref}
          >
            {activeTab === "Notifications" && (
              <div className="flex flex-col gap-4 w-full">
                <div className="shadow-menu rounded-lg bg-white p-4 w-full">
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    className="delay-300 w-full"
                    parentClassName="w-full"
                  >
                    <NotificationSettings />
                  </RevealTextLine>
                </div>
                <div className="shadow-menu rounded-lg bg-white p-4 w-full">
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    className="delay-500 w-full"
                    parentClassName="w-full"
                  >
                    <EmailNotificationSection />
                  </RevealTextLine>
                </div>
              </div>
            )}

            {activeTab === "File Settings" && (
              <div className="flex flex-col gap-4 w-full">
                <div className="shadow-menu rounded-lg bg-white p-4 w-full">
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    className="delay-300 w-full"
                    parentClassName="w-full"
                  >
                    <UpdateSyncFolder />
                  </RevealTextLine>
                </div>
                <div className="shadow-menu rounded-lg bg-white p-4 w-full">
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    className="delay-500 w-full"
                    parentClassName="w-full"
                  >
                    <FileDeletionBehaviour />
                  </RevealTextLine>
                </div>
              </div>
            )}
            {activeTab === "Master Token" && (
              <div className="shadow-menu rounded-lg bg-white p-4 w-full">
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                  parentClassName="w-full"
                >
                  <OAuthTokenSection />
                </RevealTextLine>
              </div>
            )}

            {activeTab === "Customize RPC" && (
              <div className="shadow-menu rounded-lg bg-white p-4 w-full">
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                  parentClassName="w-full"
                >
                  <CustomizeRPC />
                </RevealTextLine>
              </div>
            )}
          </div>
        )}
      </InView>
    </div>
  );
};

export default SettingsDialogContent;

import React, { useEffect, useState, useRef } from "react";
import { Icons, RevealTextLine } from "@/components/ui";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import { InView } from "react-intersection-observer";
import MultiFolderSyncManager from "./MultiFolderSyncManager";
import NotificationSettings from "./NotificationSettings";
import { useAtom } from "jotai";
import { activeSettingsTabAtom, settingsSidebarCollapsedAtom } from "@/app/components/sidebar/sideBarAtoms";
import { useSetAtom } from "jotai";
import { refreshEnabledTypesAtom } from "@/components/page-sections/notifications/notificationStore";
import CustomizeRPC from "./CustomizeRPC";

import { ApiTokenCard, ApiTokenUsageCard } from "./OAuthTokenSection";
import EmailNotificationSection from "./EmailNotificationSection";
import RecoveryPhraseSettings from "./RecoveryPhraseSettings";
import DeviceNameSetting from "./DeviceNameSetting";

const SETTINGS_COLLAPSE_WIDTH = 900;

/** Effective viewport width accounting for zoom */
function getEffectiveWidth(): number {
  const stored = localStorage.getItem("hippius-zoom-level");
  const zoom = stored ? parseInt(stored, 10) : 100;
  return window.innerWidth / (zoom / 100);
}

const SettingsDialogContent: React.FC = () => {
  const [activeTab, setActiveTab] = useAtom(activeSettingsTabAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const setSettingsCollapsed = useSetAtom(settingsSidebarCollapsedAtom);
  const [iconOnly, setIconOnly] = useState(() => getEffectiveWidth() < SETTINGS_COLLAPSE_WIDTH);
  const iconOnlyRef = useRef(iconOnly);
  iconOnlyRef.current = iconOnly;

  // Sync collapse state with atom for SettingsDialog header margin
  useEffect(() => {
    setSettingsCollapsed(iconOnly);
  }, [iconOnly, setSettingsCollapsed]);

  // Auto-collapse settings sidebar when effective viewport is narrow
  useEffect(() => {
    const handleChange = () => {
      const shouldCollapse = getEffectiveWidth() < SETTINGS_COLLAPSE_WIDTH;
      if (shouldCollapse !== iconOnlyRef.current) {
        setIconOnly(shouldCollapse);
      }
    };

    window.addEventListener("resize", handleChange);
    window.addEventListener("zoom-changed", handleChange);
    return () => {
      window.removeEventListener("resize", handleChange);
      window.removeEventListener("zoom-changed", handleChange);
    };
  }, []);
  // Refresh notification types when the settings dialog shows the notifications tab
  useEffect(() => {
    if (activeTab === "Notifications") {
      refreshEnabledTypes();
    }
  }, [activeTab, refreshEnabledTypes]);

  const tabs: TabOption[] = [
    {
      tabName: "Sync & Storage",
      icon: <Icons.Folder className="size-4" />,
    },
    {
      tabName: "Security",
      icon: <Icons.KeySquare className="size-4" />,
    },
    // "Console Access" removed: account recovery is now always-on and
    // configured during OAuth signup. The Settings surface is gone but
    // the backend IPC commands (`enable_console_access`,
    // `rotate_console_passphrase`, etc.) remain registered for legacy
    // in-flight sessions. Full backend cleanup lives in a follow-up PR.
    {
      tabName: "API Token",
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
      <div className="pt-[1.125rem] mr-8 shrink-0 sticky top-0 self-start">
        <TabList
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          className=" flex-col"
          width="min-w-[10.5rem]"
          isJustifyStart
          showTooltip={false}
          iconOnly={iconOnly}
        />
      </div>

      <div className="flex-1 min-w-0 @container">
        <InView triggerOnce>
          {({ inView, ref }) => (
            <div
              key={activeTab}
              className="flex flex-col animate-in fade-in duration-300 gap-8 w-full h-max mb-4 pt-[1.125rem]"
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

            {activeTab === "Security" && (
              <div className="flex flex-col gap-4 w-full">
                <RecoveryPhraseSettings />
              </div>
            )}

            {activeTab === "Sync & Storage" && (
              <div className="flex flex-col gap-4 w-full">
                <div className="shadow-menu rounded-lg bg-white p-4 w-full">
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    className="delay-300 w-full"
                    parentClassName="w-full"
                  >
                    <DeviceNameSetting />
                  </RevealTextLine>
                </div>
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-500 w-full"
                  parentClassName="w-full overflow-visible"
                >
                  <MultiFolderSyncManager />
                </RevealTextLine>
              </div>
            )}
            {activeTab === "API Token" && (
              <div className="flex flex-col gap-4 w-full">
                <div className="shadow-menu rounded-lg bg-white p-4 w-full">
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    className="delay-300 w-full"
                    parentClassName="w-full"
                  >
                    <ApiTokenCard />
                  </RevealTextLine>
                </div>
                <div className="shadow-menu rounded-lg bg-white p-4 w-full">
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    className="delay-500 w-full"
                    parentClassName="w-full"
                  >
                    <ApiTokenUsageCard />
                  </RevealTextLine>
                </div>
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
    </div>
  );
};

export default SettingsDialogContent;

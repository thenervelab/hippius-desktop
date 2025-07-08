"use client";

import React, { useState } from "react";
import { Icons, RevealTextLine } from "../../ui";
import ChangePasscode from "./ChangePasscode";
import AccountActionButtons from "./AccountActionButtons";
import ExportEncryptedSeed from "./ExportEncryptedSeed";
import { InView } from "react-intersection-observer";
import SubAccounts from "./sub-accounts";
import DashboardTitleWrapper from "../../dashboard-title-wrapper";
import TabList from "../../ui/tabs/tab-list";

const Settings = () => {
  const [activeTab, setActiveTab] = useState("General Settings");

  const tabs = [
    {
      tabName: "General Settings",
      icon: <Icons.BoxTime />,
    },
    {
      tabName: "Sub Accounts",
      icon: <Icons.KeySquare />,
    },
  ];

  return (
    <DashboardTitleWrapper mainText="Settings">
      <div className="mt-6">
        <TabList
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          className="max-w-fit"
        />
      </div>

      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            className="flex flex-col mt-8 animate-in fade-in duration-300 gap-8"
            ref={ref}
          >
            {activeTab === "General Settings" && (
              <>
                <div className="flex gap-4 w-full">
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    parentClassName="w-[68.27%]"
                    className="delay-300 w-full"
                  >
                    <ChangePasscode />
                  </RevealTextLine>
                  <RevealTextLine
                    rotate
                    reveal={inView}
                    parentClassName="w-[31.73%]"
                    className="delay-300 w-full"
                  >
                    <ExportEncryptedSeed />
                  </RevealTextLine>
                </div>
                <RevealTextLine
                  rotate
                  reveal={inView}
                  className="delay-300 w-full"
                >
                  <AccountActionButtons />
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
          </div>
        )}
      </InView>
    </DashboardTitleWrapper>
  );
};

export default Settings;

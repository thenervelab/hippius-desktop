"use client";

import React from "react";
import { RevealTextLine } from "../../ui";
import ChangePasscode from "./ChangePasscode";
import AccountActionButtons from "./AccountActionButtons";
import ExportEncryptedSeed from "./ExportEncryptedSeed";
import { InView } from "react-intersection-observer";
import SubAccounts from "./sub-accounts";
import DashboardTitleWrapper from "../../dashboard-title-wrapper";

const Settings = () => {
  return (
    <DashboardTitleWrapper mainText="Settings">
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div className="flex flex-col mt-12" ref={ref}>
            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <ExportEncryptedSeed inView={inView} />
            </RevealTextLine>
            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <ChangePasscode />
            </RevealTextLine>
            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <SubAccounts />
            </RevealTextLine>
            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <AccountActionButtons />
            </RevealTextLine>
          </div>
        )}
      </InView>
    </DashboardTitleWrapper>
  );
};

export default Settings;

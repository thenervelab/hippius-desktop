"use client";

import React from "react";
import BlockchainStats from "../../blockchain-stats";
import SearchBar from "../../search-bar";
import { RevealTextLine } from "../../ui";
import ChangePasscode from "./ChangePasscode";
import AccountActionButtons from "./AccountActionButtons";
import ExportEncryptedSeed from "./ExportEncryptedSeed";
import { InView } from "react-intersection-observer";
import SubAccounts from "./sub-accounts";

const Settings = () => {
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div className="flex flex-col" ref={ref}>
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <div className="flex justify-between items-center w-full">
              <SearchBar />
              <BlockchainStats />
            </div>
          </RevealTextLine>
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <h1 className="text-2xl font-medium text-grey-10 mb-8">Settings</h1>
          </RevealTextLine>

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
  );
};

export default Settings;

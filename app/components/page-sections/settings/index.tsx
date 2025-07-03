"use client";

import React from "react";
import BlockchainStats from "../../blockchain-stats";
import SearchBar from "../../search-bar";
import { CardButton, RevealTextLine } from "../../ui";
import { Zip } from "../../ui/icons";
import ChangePasscode from "./ChangePasscode";
import AccountActionButtons from "./AccountActionButtons";
import { InView } from "react-intersection-observer";

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

          <div className="flex items-center mb-5">
            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <div className="w-[260px] text-grey-10 text-lg font-medium">
                Export encrypted seed
              </div>
            </RevealTextLine>
            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <CardButton className="h-[40px] w-fit p-1">
                <div className="flex items-center gap-2 text-grey-100 text-base font-medium p-2">
                  <div>
                    <Zip className="size-4" />
                  </div>
                  <span className="flex items-center">Download Zip</span>
                </div>
              </CardButton>
            </RevealTextLine>
          </div>
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <ChangePasscode />
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

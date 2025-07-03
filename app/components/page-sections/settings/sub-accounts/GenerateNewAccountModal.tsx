"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CloseCircle,
  HippiusLogo,
  ShieldSecurity,
  OctagonAlert,
} from "@/components/ui/icons";
import { Copy, Check, MoveRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Graphsheet } from "@/app/components/ui";

type Props = {
  open: boolean;
  onClose: () => void;
  copyToClipboard: () => void;
  generatedMnemonic: string;
  copied: boolean;
  onAddAsSubAccount: () => void; // Add this new prop
};

export default function GenerateNewAccountModal({
  open,
  onClose,
  copyToClipboard,
  generatedMnemonic,
  copied,
  onAddAsSubAccount,
}: Props) {
  const warnings = [
    {
      id: 1,
      text: "Store this key in a secure password manager",
    },
    {
      id: 2,
      text: "Never share it with anyone",
    },
    {
      id: 3,
      text: (
        <div>
          We <b>cannot</b> help you recover your account if you lose this key
        </div>
      ),
    },
  ];
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
        <Dialog.Content
          className="
            fixed left-1/2 top-1/2 z-50 
            w-full max-w-sm sm:max-w-[488px] 
            -translate-x-1/2 -translate-y-1/2
            bg-white rounded-[8px]
            shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
            p-[16px]
          "
        >
          <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
          <Dialog.Close asChild className="sm:hidden">
            <button
              aria-label="Close"
              className="absolute top-11 right-4 text-grey-10 hover:text-grey-20"
            >
              <CloseCircle className="size-6" />
            </button>
          </Dialog.Close>

          {/* Icon */}
          <div className="flex items-center sm:justify-center">
            <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
              <Graphsheet
                majorCell={{
                  lineColor: [31, 80, 189, 1],
                  lineWidth: 2,
                  cellDim: 40,
                }}
                minorCell={{
                  lineColor: [31, 80, 189, 1],
                  lineWidth: 2,
                  cellDim: 40,
                }}
                className="absolute w-full h-full top-0 bottom-0 left-0 duration-300 opacity-10 hidden sm:block"
              />
              <div className="flex items-center justify-center size-8 bg-primary-50 rounded-[8px] relative">
                <HippiusLogo className="size-5 text-white" />
              </div>
            </div>
          </div>

          <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center py-[16px]">
            Generate a New Account
          </Dialog.Title>

          <div>
            <div className="flex flex-col gap-[8px]">
              <label className="font-medium text-grey-70 text-sm">
                Your account access Key
              </label>
              <div
                className="p-[16px] shadow-[0_0_0_4px_rgba(10,10,10,0.05)] rounded-[8px]
             border border-grey-80 text-grey-30 gap-[8px] flex justify-between items-start"
              >
                <ShieldSecurity className="text-grey-60 w-[24px] h-[24px]" />

                <span className="text-base font-medium break-all">
                  {generatedMnemonic}
                </span>
                <Button
                  type="button"
                  onClick={copyToClipboard}
                  className={cn(
                    "h-auto hover:bg-transparent w-10",
                    copied
                      ? "text-green-600"
                      : "text-grey-60 hover:text-grey-70"
                  )}
                  variant="ghost"
                >
                  {copied ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>
            <div className="flex gap-[8px] border-t-2 py-[16px] border-grey-90 mt-[16px] items-center">
              <OctagonAlert className="text-warning-50 w-[24px] h-[24px]" />
              <span className="text-lg font-semibold text-grey-10">
                Important
              </span>
            </div>
            <div className="flex flex-col gap-[8px]">
              {warnings?.map((item) => {
                return (
                  <div
                    key={item?.id}
                    className="text-grey-50 font-medium text-sm flex gap-[8px] items-center"
                  >
                    <MoveRight className="text-grey-80 h-[20px] w-[20px]" />
                    <span>{item?.text}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-[16px] flex flex-col gap-[16px] text-lg font-medium">
            <button
              onClick={onAddAsSubAccount}
              className="
                w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                hover:bg-primary-40 transition
              "
            >
              <div className="py-2.5 rounded border border-primary-40 text-lg">
                Add as Sub Account
              </div>
            </button>
            <Dialog.Close asChild>
              <button
                onClick={onClose}
                className="
                  w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10
                  hover:bg-grey-80 transition hidden sm:block
                  
                "
              >
                Cancel
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

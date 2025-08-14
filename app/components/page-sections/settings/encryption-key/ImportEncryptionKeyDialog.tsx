"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import { AbstractIconWrapper, Icons } from "@/app/components/ui";
import PasscodeInput from "./PasscodeInput";
import ImportantWarnings from "@/app/components/ui/ImportantWarnings";

type Warning = {
  id: number;
  text: string | React.ReactNode;
};

type Props = {
  open: boolean;
  onClose: () => void;
  copyToClipboard: () => void;
  importedMnemonic: string;
  copied: boolean;
  onDone: () => void;
  customWarnings?: Warning[];
  inView: boolean;
};

export default function ImportEncryptionKeyDialog({
  open,
  onClose,
  copyToClipboard,
  importedMnemonic,
  copied,
  onDone,
  customWarnings,
  inView,
}: Props) {
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
              <AbstractIconWrapper className="size-10 rounded-2xl text-primary-50 mb-2">
                <Icons.CopySuccess className="absolute size-6" />
              </AbstractIconWrapper>
            </div>
          </div>

          <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center py-[16px]">
            Encryption Key Successfully Imported!
          </Dialog.Title>

          <div>
            <PasscodeInput
              passcode={importedMnemonic}
              onPasscodeChange={() => { }}
              showPasscode={true}
              copied={copied}
              showCopy
              copyToClipboard={copyToClipboard}
              label="Imported Encryption Key"
              placeholder=""
              inView={inView}
              reveal={inView}
              className="w-full"
            />

            <ImportantWarnings
              inView={inView}
              usePasscode={false}
              className="mt-4"
              customWarnings={customWarnings}
            />
          </div>

          <div className="mt-[16px] flex flex-col gap-[16px] text-lg font-medium">
            <Dialog.Close asChild>
              <button
                onClick={onDone}
                className="
                w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                hover:bg-primary-40 transition
              "
              >
                <div className="py-2.5 rounded border border-primary-40 text-lg">
                  Done
                </div>
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

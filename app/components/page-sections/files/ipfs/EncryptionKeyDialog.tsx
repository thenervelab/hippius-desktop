"use client";

import React, { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle, ShieldSecurity } from "@/components/ui/icons";
import { AbstractIconWrapper, RevealTextLine } from "@/app/components/ui";
import { Input } from "@/components/ui";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { FormattedUserIpfsFile } from "@/app/lib/hooks/use-user-ipfs-files";

type Props = {
  open: boolean;
  onClose: () => void;
  onDownload: (encryptionKey: string | null) => void;
  keyError: string | null;
  isFolder?: boolean;
  file?: FormattedUserIpfsFile | null;
};

export default function EncryptionKeyDialog({
  open,
  onClose,
  onDownload,
  keyError,
  isFolder = false,
  file
}: Props) {
  const [encryptionKey, setEncryptionKey] = useState("");
  const [internalKeyError, setInternalKeyError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (keyError) {
      setInternalKeyError(keyError);
    }
  }, [keyError]);

  const handleClose = () => {
    setEncryptionKey("");
    setInternalKeyError(null);
    onClose();
  };

  const handleDownload = () => {
    setIsSubmitting(true);
    onDownload(encryptionKey.trim() || null);
    setIsSubmitting(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
        <Dialog.Content
          className="
            fixed left-1/2 top-1/2 z-[1000] 
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
              <AbstractIconWrapper className="size-10 rounded-2xl text-primary-50 ">
                <ShieldSecurity className="absolute size-6" />
              </AbstractIconWrapper>
            </div>
          </div>

          <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center pt-2">
            Decrypt {(isFolder || file?.isFolder) ? "Folder" : "File"}
          </Dialog.Title>

          <div className="space-y-4">
            <div className="text-grey-70 text-sm text-center mb-8">
              <RevealTextLine rotate reveal={true} className="delay-300">
                Please enter your encryption key to decrypt your {(isFolder || file?.isFolder) ? "folder" : "file"}.
              </RevealTextLine>
            </div>

            <div className="space-y-1">
              <Label
                htmlFor="encryptionKey"
                className="text-sm font-medium text-grey-70"
              >
                Encryption Key (optional)
              </Label>
              <div className="relative flex items-start w-full">
                <ShieldSecurity className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
                <Input
                  id="encryptionKey"
                  placeholder="Enter encryption key"
                  value={encryptionKey}
                  onChange={(e) => {
                    setEncryptionKey(e.target.value);
                    setInternalKeyError(null);
                  }}
                  className={`pl-11 border-grey-80 h-14 text-grey-30 w-full
                    bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
                    hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus
                    ${internalKeyError ? "border-error-50 focus:border-error-50" : ""}`}
                />
              </div>
              <p className="text-xs text-grey-70">
                {encryptionKey.trim()
                  ? `Using custom encryption key for this ${(isFolder || file?.isFolder) ? "folder" : "file"}.`
                  : "Default encryption key will be used if left empty."}
              </p>

              {internalKeyError && (
                <div className="flex text-error-70 text-sm font-medium items-center gap-2">
                  <AlertCircle className="size-4 !relative" />
                  <span>{internalKeyError}</span>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={handleDownload}
                className="w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40 hover:bg-primary-40 transition"
                disabled={isSubmitting}
              >
                <div className="py-2.5 rounded border border-primary-40 text-lg">
                  {isSubmitting ? "Downloading..." : "Download"}
                </div>
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10 hover:bg-grey-90 transition text-lg font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

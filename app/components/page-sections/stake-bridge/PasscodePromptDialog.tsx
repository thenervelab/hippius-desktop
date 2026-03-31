"use client";

import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import { P } from "@/components/ui/typography";
import ButtonCard from "../../ui/button/CardButton";
import { Graphsheet } from "../../ui";

interface PasscodePromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (passcode: string) => Promise<boolean>;
}

export default function PasscodePromptDialog({
  open,
  onOpenChange,
  onSubmit,
}: PasscodePromptDialogProps) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setPasscode("");
      setError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!passcode.trim()) {
      setError("Please enter your passcode");
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const ok = await onSubmit(passcode);
      if (ok) {
        setPasscode("");
        onOpenChange(false);
      } else {
        setError("Incorrect passcode");
      }
    } catch {
      setError("Failed to unlock wallet");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="bg-white/70 fixed px-4 z-10 top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3">
          <Dialog.Content className="relative p-4 border shadow-dialog bg-white flex flex-col max-w-[26.75rem] max-h-[75vh] h-auto overflow-y-auto custom-scrollbar-thin border-grey-80 bg-background-1 rounded sm:rounded-[0.5rem] overflow-hidden w-full data-[state=open]:animate-scale-in-95-0.2">
            <Graphsheet
              majorCell={{
                lineColor: [246, 248, 254, 1.0],
                lineWidth: 2,
                cellDim: 50,
              }}
              minorCell={{
                lineColor: [255, 255, 255, 1.0],
                lineWidth: 0,
                cellDim: 0,
              }}
              className="absolute w-full h-full left-0 top-0"
            />
            <div className="flex items-center text-grey-10 relative mt-2 sm:mt-0">
              <div className="text-[1.375rem] lg:text-2xl text-grey-10 sm:flex w-full font-medium relative">
                <Dialog.Title>Unlock Wallet</Dialog.Title>
              </div>
              <button
                className="ml-auto"
                onClick={() => onOpenChange(false)}
              >
                <CloseCircle className="size-6 relative text-grey-10" />
              </button>
            </div>

            <div className="pt-2 grow flex flex-col relative">
              <P size="sm" className="text-grey-70 mb-4">
                Enter your passcode to sign this transaction.
              </P>

              <input
                type="password"
                placeholder="Enter passcode"
                value={passcode}
                onChange={(e) => {
                  setPasscode(e.target.value);
                  setError(null);
                }}
                onKeyDown={handleKeyDown}
                className="w-full px-3 py-2 border border-grey-80 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-50 mb-2"
                autoFocus
              />

              {error && (
                <P size="sm" className="text-red-500 mb-2">
                  {error}
                </P>
              )}

              <div className="flex gap-3 mt-4">
                <ButtonCard
                  variant="secondary"
                  className="flex-1"
                  onClick={() => onOpenChange(false)}
                  disabled={loading}
                >
                  Cancel
                </ButtonCard>
                <ButtonCard
                  className="flex-1"
                  onClick={handleSubmit}
                  loading={loading}
                >
                  Unlock
                </ButtonCard>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

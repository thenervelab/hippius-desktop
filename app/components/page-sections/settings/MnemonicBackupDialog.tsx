"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "../../ui/DialogContainer";
import { Button } from "../../ui/button";
import { Eye, EyeOff, Copy, Check, AlertTriangle } from "lucide-react";

interface MnemonicBackupDialogProps {
  open: boolean;
  mnemonic: string;
  onConfirm: () => void;
}

export function MnemonicBackupDialog({
  open,
  mnemonic,
  onConfirm,
}: MnemonicBackupDialogProps) {
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy mnemonic:", err);
    }
  };

  const words = mnemonic.split(" ");
  const maskedMnemonic = words.map(() => "••••••").join(" ");

  return (
    <Dialog.Root open={open}>
      <DialogContainer>
        <div className="p-6 flex flex-col gap-4">
          <div>
            <Dialog.Title className="text-lg font-semibold">
              Backup Your Recovery Phrase
            </Dialog.Title>
            <Dialog.Description className="text-sm text-grey-400 mt-1">
              This recovery phrase is required to restore your encrypted files on new devices.
            </Dialog.Description>
          </div>

          <div className="bg-warning-500/10 border border-warning-500/30 rounded-lg p-3 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-warning-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-warning-500">
                Write this down and store it safely
              </p>
              <p className="text-xs text-warning-400 mt-1">
                This phrase will only be shown once. If you lose it, you cannot recover your encrypted files.
              </p>
            </div>
          </div>

          <div className="bg-grey-800 rounded-lg p-4 relative">
            <div className="font-mono text-sm leading-relaxed pr-20">
              {showMnemonic ? (
                <div className="grid grid-cols-3 gap-2">
                  {words.map((word, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <span className="text-grey-500 text-xs w-5">{index + 1}.</span>
                      <span>{word}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-grey-500 break-words">{maskedMnemonic}</div>
              )}
            </div>
            <div className="absolute top-3 right-3 flex gap-1">
              <button
                type="button"
                onClick={() => setShowMnemonic(!showMnemonic)}
                className="p-2 hover:bg-grey-700 rounded-md transition-colors"
                title={showMnemonic ? "Hide" : "Show"}
              >
                {showMnemonic ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
              <button
                type="button"
                onClick={handleCopy}
                className="p-2 hover:bg-grey-700 rounded-md transition-colors"
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-500" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          <label className="flex items-start gap-3 cursor-pointer p-3 bg-grey-800/50 rounded-lg hover:bg-grey-800 transition-colors">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="w-5 h-5 rounded border-grey-600 mt-0.5"
            />
            <div>
              <span className="text-sm font-medium">
                I have securely backed up my recovery phrase
              </span>
              <p className="text-xs text-grey-400 mt-1">
                I understand that losing this phrase means losing access to my encrypted files
              </p>
            </div>
          </label>

          <div className="flex justify-end mt-2">
            <Button onClick={onConfirm} disabled={!confirmed}>
              Continue
            </Button>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}

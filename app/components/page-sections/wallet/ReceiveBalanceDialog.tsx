"use client";

import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import QRCode from "react-qr-code";

import { Button } from "@/components/ui/button";
import { InGoing } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { WalletDialogShell } from "./shared/WalletDesign";

/* Receive Balance dialog.
 *
 * Phase 2 of the wallet redesign — ported from the hippius-web console
 * onto WalletDialogShell. Surfaces an info banner explaining the SS58
 * address, the QR code itself, and a copy-to-clipboard address row.
 *
 * Desktop signs locally so there's no extension-vs-mnemonic branching
 * in this surface — just renders the local account's polkadot address.
 * The confidentiality masking from console is intentionally dropped:
 * the desktop confidentiality system isn't wired up yet. */

export interface ReceiveBalanceDialogProps {
  open: boolean;
  onClose: () => void;
  polkadotAddress: string;
}

const SUFFIX_LEN = 6;

const ReceiveBalanceDialog: React.FC<ReceiveBalanceDialogProps> = ({
  open,
  onClose,
  polkadotAddress,
}) => {
  const fullAddress = polkadotAddress || "";
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullAddress);
      toast.success("Address copied to clipboard!");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy address");
    }
  };

  return (
    <WalletDialogShell
      open={open}
      onClose={onClose}
      title="Receive Balance"
      description="Deposit Address"
      icon={<InGoing className="size-3 text-white" />}
      iconTitleGap="mt-4 mb-4"
      maxWidth="sm:max-w-[540px] sm:min-w-[540px]"
      contentClassName="sm:w-full"
      footer={
        <div className="flex justify-center">
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            className="h-11 sm:h-[52px] w-full rounded-[8px] border border-grey-80 bg-white px-4 text-base sm:text-[18px] font-normal leading-5 tracking-[-0.36px] text-grey-10 hover:bg-grey-90 dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#373737]"
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Info banner explaining the SS58 address. */}
        <div className="py-2 px-3 rounded-[14px] border border-[#3167DD] bg-[#3167DD33] dark:border-[#4a7aff] dark:bg-[#1e2d50]">
          <p className="text-[10px] font-bold text-[#3167DD] dark:text-[#6b9aff] mb-1">
            Info
          </p>
          <p className="text-[10px] font-medium leading-relaxed text-[#3167DD] dark:text-[#6b9aff]">
            Use this address to receive hAlpha tokens on the Hippius network.
            This is your SS58 encoded Substrate address and is compatible with
            Polkadot and other Substrate based chains.
          </p>
        </div>

        {/* QR code */}
        <div className="rounded-[14px] bg-[#f4f4f4] p-5 dark:bg-[#2a2a2a] flex justify-center">
          <QRCode
            value={fullAddress || "Unavailable"}
            size={280}
            style={{
              height: "280px",
              width: "280px",
              flexShrink: 0,
              backgroundColor: "transparent",
              background: "transparent",
            }}
            viewBox="0 0 256 256"
          />
        </div>

        {/* Address field with CSS-only center truncation: the prefix
            truncates via native ellipsis while a fixed-width suffix
            stays visible, so the address always shows its first chars
            (which differ between accounts) and its tail (which the
            user can visually verify against an external source). */}
        <div>
          <label className="text-xs sm:text-sm text-grey-70 dark:text-grey-dark-800 font-medium mb-1.5 sm:mb-2 block">
            Deposit Address
          </label>

          <div className="flex items-center border border-grey-80 dark:border-[#494949] rounded-[8px] bg-white dark:bg-[#1f1f1f] h-12 sm:h-14 px-3 sm:px-4 gap-2">
            <div className="flex flex-1 min-w-0 items-center text-[13px] text-grey-60 font-medium dark:text-white leading-[22px]">
              {fullAddress ? (
                <>
                  <span className="truncate min-w-0">
                    {fullAddress.slice(
                      0,
                      Math.max(0, fullAddress.length - SUFFIX_LEN),
                    )}
                  </span>
                  <span className="shrink-0">
                    {fullAddress.slice(-SUFFIX_LEN)}
                  </span>
                </>
              ) : (
                "---"
              )}
            </div>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!fullAddress}
              className="shrink-0 flex items-center justify-center size-8 disabled:opacity-30"
              aria-label="Copy deposit address"
            >
              {copied ? (
                <Check className="size-[18px] text-success-30" />
              ) : (
                <Copy
                  className={cn(
                    "size-[18px] text-grey-10 dark:text-white opacity-60 transition-opacity",
                    fullAddress && "hover:opacity-100",
                  )}
                />
              )}
            </button>
          </div>
        </div>
      </div>
    </WalletDialogShell>
  );
};

export default ReceiveBalanceDialog;

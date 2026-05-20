"use client";

import React from "react";
import { HippiusLogo } from "@/components/ui/icons";
import {
  WalletDialogShell,
  WalletDialogFooter,
} from "./shared/WalletDesign";

interface SendBalanceConfirmationDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
  recipientAddress: string;
  amount: string;
}

const SendBalanceConfirmationDialog: React.FC<
  SendBalanceConfirmationDialogProps
> = ({ open, onClose, onConfirm, loading, recipientAddress, amount }) => {
  const truncatedRecipient =
    recipientAddress.length > 14
      ? `${recipientAddress.substring(0, 6)}...${recipientAddress.substring(
          recipientAddress.length - 4,
        )}`
      : recipientAddress;

  return (
    <WalletDialogShell
      open={open}
      onClose={onClose}
      title="Confirm Transaction"
      description="Sending hAlpha tokens."
      icon={<HippiusLogo className="size-4 text-white" />}
      iconTitleGap="mt-4 mb-0"
      titleDescriptionGap="mt-0"
      maxWidth="max-w-[550px]"
      footer={
        <WalletDialogFooter
          primaryLabel="Confirm Transfer"
          secondaryLabel="Cancel"
          onPrimaryClick={onConfirm}
          onSecondaryClick={onClose}
          primaryLoading={loading}
          secondaryDisabled={loading}
        />
      }
    >
      <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-4 dark:bg-[#2a2a2a]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[14px] font-medium leading-[16.8px] text-[#a6a6ab]">
            Amount
          </span>
          <div className="flex items-center gap-[7px]">
            <span className="text-[14px] font-medium leading-[16.8px] text-[#0a0a0a] dark:text-white">
              {amount} hALPHA
            </span>
            <span className="flex justify-center items-center w-4 h-4 rounded-full border border-[#d0d0d0] bg-white">
              <HippiusLogo className="size-2.5 text-[#3167dd]" />
            </span>
          </div>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <span className="text-[14px] font-medium leading-[16.8px] text-[#a6a6ab]">
            Recipient
          </span>
          <span className="text-[14px] font-medium leading-[16.8px] text-[#0a0a0a] dark:text-white">
            {truncatedRecipient}
          </span>
        </div>
      </div>
    </WalletDialogShell>
  );
};

export default SendBalanceConfirmationDialog;

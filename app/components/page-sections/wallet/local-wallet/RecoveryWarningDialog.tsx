"use client";

import React from "react";
import { Check } from "lucide-react";

import ConfirmationDialog from "@/components/ConfirmationDialog";
import { OctagonAlert } from "@/components/ui/icons";

/* Surfaced once at the irreversible step of every wallet entry-flow
   (create / access / import). The wallet password and the 12-word
   access key are never sent off-device and never escrowed — losing
   either of them is unrecoverable, so we make the user explicitly
   ack the warning before the keystore writes the encrypted row. */

interface RecoveryWarningDialogProps {
  open: boolean;
  /** What the user is about to do. Tunes the dialog copy so a
      "Create Wallet" tap doesn't claim the user is "accessing" one. */
  variant: "create" | "access" | "import";
  /** True while the underlying IPC is in flight — disables the confirm
      so a double-tap can't fire two wallet writes. */
  submitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const COPY: Record<
  RecoveryWarningDialogProps["variant"],
  { heading: string; intro: string; confirmLabel: string }
> = {
  create: {
    heading: "Save Your Password & Access Key",
    intro:
      "Before we create this wallet, make sure you have saved both your password and your 12-word access key somewhere safe.",
    confirmLabel: "I Understand, Create Wallet",
  },
  access: {
    heading: "Save Your Password & Access Key",
    intro:
      "Before we unlock this wallet, make sure you have saved both your password and your 12-word access key somewhere safe.",
    confirmLabel: "I Understand, Continue",
  },
  import: {
    heading: "Save Your Password & Access Key",
    intro:
      "Before we import this wallet, make sure you have saved both the wallet's password and its 12-word access key somewhere safe.",
    confirmLabel: "I Understand, Import",
  },
};

const RecoveryWarningDialog: React.FC<RecoveryWarningDialogProps> = ({
  open,
  variant,
  submitting = false,
  onConfirm,
  onCancel,
}) => {
  const { heading, intro, confirmLabel } = COPY[variant];

  return (
    <ConfirmationDialog
      open={open}
      heading={heading}
      icon={<OctagonAlert className="size-4 text-white" />}
      iconBgColor="bg-[#F5A623]"
      borderClassName="bg-[#F5A623]"
      text={intro}
      button={confirmLabel}
      disableButton={submitting}
      disableBackButton={submitting}
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onBack={onCancel}
      onClose={onCancel}
    >
      <ul className="mb-5 flex flex-col gap-2 rounded-[8px] border border-[#F5A623]/30 bg-[#F5A623]/10 px-4 py-3 text-left text-[13px] font-medium leading-5 text-grey-20 dark:text-grey-light-100">
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-[#F5A623]" />
          <span>
            Hippius cannot recover your password if you lose it. It is
            never sent off this device.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-[#F5A623]" />
          <span>
            Hippius cannot recover your access key either. Without it
            your funds and files are permanently inaccessible.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-[#F5A623]" />
          <span>
            Store both in a password manager or somewhere offline that
            only you can reach.
          </span>
        </li>
      </ul>
    </ConfirmationDialog>
  );
};

export default RecoveryWarningDialog;

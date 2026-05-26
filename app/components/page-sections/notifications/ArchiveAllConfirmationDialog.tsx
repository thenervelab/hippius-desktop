"use client";

import React from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WalletDialogShell } from "@/components/page-sections/wallet/shared/WalletDesign";

export interface ArchiveAllConfirmationProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
}

/* "Delete all notifications" confirmation. Uses the project-wide
 * redesigned dialog shell (`WalletDialogShell`) so it speaks the
 * same visual language as Send / Stake / Withdraw / Bridge
 * confirmation dialogs. The shell is named after wallet because
 * that's where the design landed first; the chrome itself is
 * neutral and we deliberately reuse it cross-section.
 *
 * Footer is hand-rolled (not via `WalletDialogFooter`) so we can
 * surface a destructive primary button — the shared footer only
 * supports the `primary` / `primaryLight` variants. */
const ArchiveAllConfirmationDialog: React.FC<ArchiveAllConfirmationProps> = ({
  open,
  onClose,
  onConfirm,
  loading = false,
}) => {
  return (
    <WalletDialogShell
      open={open}
      onClose={onClose}
      title="Delete all notifications?"
      description="This will permanently remove all notifications from your history. This action cannot be undone."
      icon={<Trash2 className="size-4 text-white" />}
      // Border + icon background pinned to the destructive Button
      // variant's coral (`bg-[#fc7d73]`) so the whole dialog reads as
      // a single visual unit: the accent ring around the card, the
      // trash badge, and the "Delete All" CTA all share the same
      // colour token. Previously the border defaulted to the wallet
      // blue and the badge used the deeper `error-50` red, which
      // read as three unrelated reds at a glance.
      borderClassName="bg-[#fc7d73]"
      iconBgClassName="bg-[#fc7d73]"
      iconTitleGap="mt-4 mb-1"
      titleDescriptionGap="mt-1"
      maxWidth="max-w-[560px]"
      footer={
        <div className="flex gap-4">
          <Button
            type="button"
            variant="defaultStable"
            className="h-[40px] flex-1 rounded-[6px] border border-[#e3e3e3] bg-[#fefefe] px-4 text-[13px] font-medium tracking-[-0.26px] text-[#4f4f4f] dark:border-[#494949] dark:bg-[#2a2a2a] dark:text-white"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-[40px] flex-1 rounded-[6px] px-4 text-[14px] font-medium tracking-[-0.28px] text-white"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Deleting…" : "Delete All"}
          </Button>
        </div>
      }
    >
      {/* No body content — the description on the shell carries the
       *  message; padding the body with the same copy would just look
       *  duplicated. */}
      <div />
    </WalletDialogShell>
  );
};

export default ArchiveAllConfirmationDialog;

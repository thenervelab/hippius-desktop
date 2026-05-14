"use client";

import React from "react";

import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { CloseCircle } from "@/components/ui/icons";

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
}

export default function ConfirmModal({
  open,
  title,
  description,
  loading,
  onConfirm,
  onCancel,
  confirmText = "Confirm",
  cancelText = "Cancel",
}: ConfirmModalProps) {
  const handleClose = () => {
    if (loading) return;
    onCancel();
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title={title}
      icon={<CloseCircle className="size-[21.33px] text-white" />}
      maxWidth="max-w-[600px]"
    >
      <div className="mx-auto mt-1 max-w-[20.25rem] text-center text-[16px] font-medium leading-6 tracking-[-0.32px] text-grey-50 dark:text-[#a3a3a3]">
        {description}
      </div>

      <div className="mt-6 space-y-3">
        <Button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          variant="primary"
          size="auto"
          className="h-[52px] w-full rounded-[8px] px-4 text-[18px] font-medium leading-5 tracking-[-0.36px] shadow-[0px_4px_4px_0px_rgba(4,65,149,0.1)]"
        >
          {loading ? "Processing..." : confirmText}
        </Button>

        <Button
          type="button"
          onClick={handleClose}
          disabled={loading}
          variant="defaultStable"
          size="auto"
          dotColor="rgba(0, 0, 0, 0.37)"
          className="h-[52px] w-full rounded-[8px] border border-grey-80 bg-white px-4 text-[18px] font-normal leading-5 tracking-[-0.36px] text-grey-10 hover:bg-grey-90 hover:rounded-[8px] dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#373737]"
        >
          {cancelText}
        </Button>
      </div>
    </FramedDialog>
  );
}

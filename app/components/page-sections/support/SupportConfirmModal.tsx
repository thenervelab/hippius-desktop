"use client";

import React from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  variant: "create" | "delete" | "close";
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
  variant,
  confirmText,
  cancelText,
}: ConfirmModalProps) {
  return (
    <ConfirmDialog
      mode="branded"
      open={open}
      title={title}
      description={description}
      isLoading={loading}
      onConfirm={onConfirm}
      onCancel={onCancel}
      brandedVariant={variant}
      confirmText={confirmText}
      cancelText={cancelText}
    />
  );
}

"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons } from "@/components/ui";
import { Input } from "@/components/ui/input/Input2";
import { HCFS_CONFIG } from "@/app/lib/config";
import { AlertCircle, Lock } from "lucide-react";
import { Label } from "@/components/ui/label";

interface HcfsSetupDialogProps {
  open: boolean;
  onClose: () => void;
  onComplete: (result: { serverUrl: string; password: string }) => void;
  loading?: boolean;
}

export function HcfsSetupDialog({
  open,
  onClose,
  onComplete,
  loading = false,
}: HcfsSetupDialogProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = () => {
    setError("");

    if (!password) {
      setError("Password is required");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    onComplete({ serverUrl: HCFS_CONFIG.defaultServerUrl, password });
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen && !loading) {
      onClose();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <DialogContainer
        className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit"
        preventClose={loading}
      >
        <Dialog.Title className="sr-only">Setup Sync Encryption</Dialog.Title>

        {/* Mobile accent bar */}
        <div className="h-4 bg-primary-50 md:hidden" />

        <div className="px-4">
          {/* Desktop Header */}
          <div className="hidden md:flex flex-col items-center justify-center pb-4 pt-4 gap-3">
            <div className="size-14 flex justify-center items-center relative">
              <Graphsheet
                majorCell={{
                  lineColor: [31, 80, 189, 1.0],
                  lineWidth: 2,
                  cellDim: 200,
                }}
                minorCell={{
                  lineColor: [49, 103, 211, 1.0],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className="h-8 w-8 bg-primary-50 rounded-lg flex items-center justify-center z-20">
                <Lock className="size-5 text-grey-100" />
              </div>
            </div>
            <span className="text-center text-2xl text-grey-10 font-medium">
              Setup Sync Encryption
            </span>
            <Dialog.Description className="text-sm text-grey-50 text-center max-w-sm">
              Set an encryption password. Your files are encrypted locally
              before upload.
            </Dialog.Description>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 md:hidden">
            <span className="text-lg font-medium">Setup Sync Encryption</span>
            <button onClick={onClose} disabled={loading}>
              <Icons.CloseCircle className="size-6" />
            </button>
          </div>
          <p className="text-sm text-grey-50 mb-4 md:hidden">
            Set an encryption password. Your files are encrypted locally
            before upload.
          </p>

          {/* Form Fields */}
          <div className="flex flex-col gap-4 mb-2">
            {/* Password */}
            <div className="flex flex-col gap-2 w-full text-grey-10">
              <Label
                htmlFor="hcfs-password"
                className="text-sm font-medium text-grey-70 flex items-center gap-2"
              >
                <Lock className="w-4 h-4" />
                Encryption Password
              </Label>
              <Input
                id="hcfs-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter a strong password"
                disabled={loading}
                className="border-grey-80 h-12 text-grey-30 w-full bg-transparent font-medium text-base rounded-lg duration-300 outline-none hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus"
              />
              <p className="text-xs text-grey-50">
                Used to encrypt your files. Choose a strong, memorable password.
              </p>
            </div>

            {/* Confirm Password */}
            <div className="flex flex-col gap-2 w-full text-grey-10">
              <Label
                htmlFor="hcfs-confirm-password"
                className="text-sm font-medium text-grey-70"
              >
                Confirm Password
              </Label>
              <Input
                id="hcfs-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your password"
                disabled={loading}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                className="border-grey-80 h-12 text-grey-30 w-full bg-transparent font-medium text-base rounded-lg duration-300 outline-none hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus"
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 text-error-70 text-sm font-medium mt-2 mb-2">
              <AlertCircle className="size-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Important Notice */}
          <div className="bg-primary-95 border border-primary-80 rounded-lg p-3 text-xs text-primary-40 text-left mt-2">
            <strong>Important:</strong> Your password cannot be recovered. If
            you forget it, you will need your recovery phrase to restore access
            to your files.
          </div>

          {/* Actions */}
          <div className="flex gap-3 my-4">
            <CardButton
              className="w-full"
              variant="secondary"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </CardButton>
            <CardButton
              className="w-full"
              onClick={handleSubmit}
              disabled={loading || !password || !confirmPassword}
              loading={loading}
            >
              {loading ? "Setting up..." : "Setup Sync"}
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}

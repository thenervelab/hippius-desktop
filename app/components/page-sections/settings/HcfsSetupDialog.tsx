"use client";

import { useState } from "react";
import { AlertCircle, Eye, EyeOff, HelpCircle, OctagonAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button, Icons, Input } from "@/components/ui";
import { HCFS_CONFIG } from "@/app/lib/config";
import { cn } from "@/lib/utils";

const ENCRYPTION_DOCS_URL =
  "https://docs.hippius.com/use/desktop/file-system#encryption";

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
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

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

  const handleClose = () => {
    if (loading) return;
    onClose();
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Setup Sync Encryption"
      icon={<Icons.Lock className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        Your files are encrypted on this device before they are uploaded.
        Choose a strong, memorable password to keep your data secure.
      </p>

      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-grey-40 dark:text-grey-dark-600">
            Encryption Password
          </span>
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter a strong password"
              disabled={loading}
              autoComplete="new-password"
              autoCapitalize="off"
              spellCheck={false}
              className="w-full pr-10"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.preventDefault();
                setShowPassword((v) => !v);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-grey-50 hover:text-grey-30 transition-colors"
            >
              {showPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-grey-40 dark:text-grey-dark-600">
            Confirm Password
          </span>
          <div className="relative">
            <Input
              type={showConfirmPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm your password"
              disabled={loading}
              autoComplete="new-password"
              autoCapitalize="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              className="w-full pr-10"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.preventDefault();
                setShowConfirmPassword((v) => !v);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-grey-50 hover:text-grey-30 transition-colors"
            >
              {showConfirmPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </label>

        {error && (
          <div className="flex items-center gap-2 text-error-70 dark:text-error-60 text-sm font-medium">
            <AlertCircle className="size-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => openUrl(ENCRYPTION_DOCS_URL)}
          className="self-start flex items-center gap-1.5 text-xs text-primary-50 hover:text-primary-40 transition-colors"
        >
          <HelpCircle className="size-3.5" />
          Learn how encryption works
        </button>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <OctagonAlert className="size-4 text-[#feb101]" />
            <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-black dark:text-white">
              Important
            </p>
          </div>
          <p className="font-geist text-[14px] leading-[1.4] tracking-[-0.28px] text-[#7d7d7d] dark:text-grey-dark-600">
            This password cannot be recovered. If you forget it, you will need
            your mnemonic seed to restore access to your files.
          </p>
        </div>

        <div className="flex gap-3">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={onClose}
            disabled={loading}
            className="h-[42px] w-full rounded-[6px] text-sm font-medium"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="auto"
            onClick={handleSubmit}
            disabled={loading || !password || !confirmPassword}
            loading={loading}
            className={cn(
              "h-[42px] w-full rounded-[6px] border text-sm font-medium",
              "border-[#3167DD] bg-[#3167DD] text-white",
              "hover:bg-[#2454c4] hover:border-[#2454c4]",
              "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
            )}
          >
            {loading ? "Setting up..." : "Setup Sync"}
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}

"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "../../ui/DialogContainer";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input/Input2";
import { HCFS_CONFIG } from "@/app/lib/config";
import { AlertCircle, Lock, Server } from "lucide-react";

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
  const [serverUrl, setServerUrl] = useState(HCFS_CONFIG.defaultServerUrl);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = () => {
    setError("");

    if (!serverUrl.trim()) {
      setError("Server URL is required");
      return;
    }

    try {
      new URL(serverUrl);
    } catch {
      setError("Please enter a valid URL");
      return;
    }

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

    onComplete({ serverUrl: serverUrl.trim(), password });
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen && !loading) {
      onClose();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <DialogContainer>
        <div className="p-6 flex flex-col gap-4">
          <div>
            <Dialog.Title className="text-lg font-semibold">
              Setup Sync Encryption
            </Dialog.Title>
            <Dialog.Description className="text-sm text-grey-400 mt-1">
              Configure your sync settings. Your password encrypts your files locally before upload.
            </Dialog.Description>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="hcfs-server-url" className="text-sm font-medium flex items-center gap-2">
              <Server className="w-4 h-4" />
              Server URL
            </label>
            <Input
              id="hcfs-server-url"
              type="url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://hcfs.hippius.com"
              disabled={loading}
            />
            <p className="text-xs text-grey-400">
              The HCFS server to sync your encrypted files to
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="hcfs-password" className="text-sm font-medium flex items-center gap-2">
              <Lock className="w-4 h-4" />
              Encryption Password
            </label>
            <Input
              id="hcfs-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter a strong password"
              disabled={loading}
            />
            <p className="text-xs text-grey-400">
              Used to encrypt your files. Choose a strong, memorable password.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="hcfs-confirm-password" className="text-sm font-medium">
              Confirm Password
            </label>
            <Input
              id="hcfs-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm your password"
              disabled={loading}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-error-500 bg-error-500/10 p-3 rounded-lg">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="bg-grey-800 p-3 rounded-lg">
            <p className="text-xs text-grey-300">
              <strong>Important:</strong> Your password cannot be recovered. If you forget it,
              you will need your recovery phrase to restore access to your files.
            </p>
          </div>

          <div className="flex justify-end gap-3 mt-2">
            <Button
              variant="secondary"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={loading || !password || !confirmPassword}
            >
              {loading ? "Setting up..." : "Setup Sync"}
            </Button>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}

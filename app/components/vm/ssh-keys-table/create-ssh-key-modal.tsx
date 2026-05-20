"use client";

import React, { useState } from "react";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import {
  Input,
  inputFieldControlClassName,
  inputFieldShellClassName,
} from "@/components/ui/input";
import { Key } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

const SSH_KEYGEN_DOCS_URL =
  "https://docs.hippius.com/use/virtual-machines#generate-an-ssh-key-pair-with-ssh-keygen";

export interface CreateSSHKeyData {
  keyName: string;
  publicKey: string;
}

export interface CreateSSHKeyModalRef {
  resetForm: () => void;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateSSHKeyData) => Promise<void>;
  isLoading?: boolean;
};

const labelClassName =
  "text-sm font-medium leading-5 tracking-[-0.28px] text-grey-dark-800";

// Figma overrides the default Input chrome: no soft 4px halo in either mode,
// and dark mode swaps to a black-300 border + 4% white fill + tight 2px black
// ring (mimics the design's "inset on dark surface" treatment).
const controlClassName =
  "mt-1.5 min-h-14 items-center !shadow-none focus-within:!shadow-none " +
  "dark:!border-black-300 dark:!bg-white/[0.04] " +
  "dark:!shadow-[0px_0px_0px_2px_#000] dark:focus-within:!shadow-[0px_0px_0px_2px_#000]";

const controlTextClassName =
  "text-base leading-[22px] tracking-[-0.32px] placeholder:text-grey-dark-800 dark:placeholder:text-grey-dark-800";

const noticeTitleClassName =
  "m-0 text-[10px] font-bold leading-4 tracking-[-0.2px] text-primary-50 dark:text-primary-65";

const noticeBodyClassName =
  "m-0 text-[10px] font-medium leading-[13px] tracking-[-0.2px] text-primary-50 dark:text-primary-65";

const CreateSSHKeyModal: React.FC<Props> = ({
  open,
  onClose,
  onSubmit,
  isLoading = false,
}) => {
  const [keyName, setKeyName] = useState("");
  const [publicKey, setPublicKey] = useState("");

  const resetForm = React.useCallback(() => {
    setKeyName("");
    setPublicKey("");
  }, []);

  const handleSubmit = async () => {
    const trimmedKeyName = keyName.trim();
    const trimmedPublicKey = publicKey.trim();

    if (!trimmedKeyName || !trimmedPublicKey) {
      toast.error("Please fill in all required fields");
      return;
    }

    try {
      await onSubmit({
        keyName: trimmedKeyName,
        publicKey: trimmedPublicKey,
      });
      // Only reset on success
      resetForm();
    } catch (error) {
      console.error("Error creating SSH key:", error);
    }
  };

  const handleClose = () => {
    if (isLoading) return;
    resetForm();
    onClose();
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Create SSH Key"
      icon={<Key className="size-[17px] text-white" />}
      maxWidth="max-w-[581px]"
      contentClassName="px-4 pb-4 pt-4 sm:w-full sm:px-4 sm:pb-4 sm:pt-4"
      titleClassName="mb-0 text-[22px] leading-8 tracking-normal sm:text-[28px] sm:leading-9"
    >
      <div className="mt-4 flex flex-col gap-[18px] font-geist">
        <div className="flex flex-col gap-[10px]">
          <div>
            <label className={labelClassName}>Key Name</label>
            <Input
              type="text"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              placeholder="Choose a name for your new key"
              wrapperClassName={controlClassName}
              className={controlTextClassName}
            />
          </div>

          <div>
            <label className={labelClassName}>Public Key</label>
            <div
              className={cn(
                inputFieldShellClassName,
                "mt-1.5 min-h-[91px] items-start gap-0",
                "!shadow-none focus-within:!shadow-none",
                "dark:!border-black-300 dark:!bg-white/[0.04]",
                "dark:!shadow-[0px_0px_0px_2px_#000] dark:focus-within:!shadow-[0px_0px_0px_2px_#000]",
              )}
            >
              <textarea
                value={publicKey}
                onChange={(event) => setPublicKey(event.target.value)}
                placeholder="ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAA... or ssh-ed25519 AAAAC3..."
                rows={3}
                className={cn(
                  inputFieldControlClassName,
                  controlTextClassName,
                  "min-h-[59px] resize-none",
                )}
              />
            </div>
          </div>
        </div>

        <div className="rounded-[14px] border border-primary-50 bg-primary-50/[0.2] px-3 py-2 dark:border-primary-65 dark:bg-primary-65/[0.2]">
          <p className={noticeTitleClassName}>SSH Key Format</p>
          <div className="mt-1">
            <p className={noticeBodyClassName}>
              Enter your public SSH key (e.g., ssh-rsa, ssh-ed25519). You can
              generate one using ssh-keygen on your local machine. Never share
              your private key.
            </p>
            <button
              type="button"
              onClick={() => openUrl(SSH_KEYGEN_DOCS_URL)}
              className="text-[10px] font-bold leading-[13px] tracking-[-0.2px] text-primary-50 underline transition-colors hover:text-[#2454c4] dark:text-primary-65 dark:hover:text-primary-brand-dark"
            >
              Learn more
            </button>
          </div>
        </div>

        <Button
          type="button"
          onClick={handleSubmit}
          disabled={isLoading || !keyName || !publicKey}
          variant="primary"
          size="auto"
          className="h-[52px] w-full gap-2 rounded-[6px] px-4 text-[18px] font-medium leading-5 tracking-[-0.36px] shadow-[0px_4px_4px_0px_rgba(4,65,149,0.1)]"
        >
          <span>{isLoading ? "Creating..." : "Create Key"}</span>
          {!isLoading ? (
            <ArrowRight className="size-[18px]" strokeWidth={2} />
          ) : null}
        </Button>

        <Button
          type="button"
          onClick={handleClose}
          disabled={isLoading}
          size="auto"
          dotColor="rgba(0, 0, 0, 0.37)"
          className="h-[52px] w-full rounded-[6px] border border-grey-80 bg-white px-4 text-[18px] font-normal leading-5 tracking-[-0.36px] text-black-600 hover:rounded-[6px] hover:bg-grey-90 dark:border-black-300 dark:bg-[#1a1a1a] dark:text-white dark:shadow-[0px_0px_0px_1px_#000] dark:hover:bg-[#252525]"
        >
          Cancel
        </Button>
      </div>
    </FramedDialog>
  );
};

CreateSSHKeyModal.displayName = "CreateSSHKeyModal";

export default CreateSSHKeyModal;

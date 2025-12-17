"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import { toast } from "sonner";
import { Input } from "@/components/ui/input/Input2";
import { Textarea } from "../../ui/Textarea";
import { Icons } from "../../ui";

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

const CreateSSHKeyModal = React.forwardRef<CreateSSHKeyModalRef, Props>(
  ({ open, onClose, onSubmit, isLoading = false }, ref) => {
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
      resetForm();
      onClose();
    };

    return (
      <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
          <Dialog.Content
            className="
            fixed left-1/2 top-1/2 z-50 
            w-full max-w-sm sm:max-w-[428px] 
            max-h-[90vh] overflow-y-auto
            -translate-x-1/2 -translate-y-1/2
            bg-white rounded-[8px]
            shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
            p-4 border border-grey-80
          "
          >
            <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
            <Dialog.Close asChild className="sm:hidden">
              <button
                aria-label="Close"
                className="absolute top-[30px] right-4 text-grey-10 hover:text-grey-20"
              >
                <CloseCircle className="size-6" />
              </button>
            </Dialog.Close>

            <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center max-sm:mt-2.5 mb-4">
              Create SSH Key
            </Dialog.Title>

            <div className="space-y-4">
              {/* Key Name */}
              <div>
                <label className="text-sm font-medium text-grey-70">
                  Key Name
                </label>
                <Input
                  type="text"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="Choose a name for your new key"
                  className="mt-2 w-full"
                />
              </div>

              {/* Public Key */}
              <div>
                <label className="text-sm font-medium text-grey-70">
                  Public Key
                </label>
                <Textarea
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                  placeholder="ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAA... or ssh-ed25519 AAAAC3..."
                  rows={4}
                  className="mt-2 w-full "
                />
              </div>
            </div>
            {/* SSH Key Info Notice */}
            <div className="mb-2 mt-4 p-3 bg-primary-95 border border-primary-80 rounded-lg">
              <div className="flex items-start gap-2">
                <div className="flex-shrink-0 mt-0.5">
                  <Icons.InfoCircle className="size-4 text-primary-50" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-primary-40 mb-1">
                    SSH Key Format
                  </p>
                  <p className="text-xs text-primary-60">
                    Enter your public SSH key (e.g., ssh-rsa, ssh-ed25519). You
                    can generate one using ssh-keygen on your local machine.
                    Never share your private key.
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-6 space-y-3">
              <button
                onClick={handleSubmit}
                disabled={isLoading || !keyName || !publicKey}
                className="
                w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                hover:bg-primary-40 transition disabled:opacity-50 disabled:cursor-not-allowed
              "
              >
                <div className="py-2.5 rounded border border-primary-40 text-lg">
                  {isLoading ? "Creating..." : "Create Key"}
                </div>
              </button>
              <Dialog.Close asChild>
                <button
                  onClick={handleClose}
                  disabled={isLoading}
                  className="
                  w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10
                  hover:bg-grey-80 transition
                  text-lg font-medium hidden sm:block
                  disabled:opacity-50 disabled:cursor-not-allowed
                "
                >
                  Cancel
                </button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
);

CreateSSHKeyModal.displayName = "CreateSSHKeyModal";

export default CreateSSHKeyModal;

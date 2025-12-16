"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import { toast } from "sonner";

export interface CreateSSHKeyData {
  keyName: string;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateSSHKeyData) => void;
  isLoading?: boolean;
};

const CreateSSHKeyModal: React.FC<Props> = ({
  open,
  onClose,
  onSubmit,
  isLoading = false,
}) => {
  const [keyName, setKeyName] = useState("");

  const resetForm = () => {
    setKeyName("");
  };

  const handleSubmit = () => {
    if (!keyName) {
      return;
    }
    toast.success("SSH Key Created Successfully");

    onSubmit({
      keyName,
    });

    resetForm();
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
              <input
                type="text"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="Choose a name for your new key"
                className="
                  mt-2 w-full bg-grey-100 text-grey-60 placeholder-grey-60
                  border border-grey-80 p-4 rounded-[8px]
                  focus:outline-none focus:border-grey-80 text-base font-medium
                "
              />
            </div>
          </div>

          <div className="mt-6 space-y-3">
            <button
              onClick={handleSubmit}
              disabled={isLoading || !keyName}
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
};

export default CreateSSHKeyModal;

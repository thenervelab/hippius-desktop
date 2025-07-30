import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import { Icons } from "../../ui";
import { ShieldCheck } from "lucide-react";

interface SendBalanceConfirmationDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
  recipientAddress: string;
  amount: string;
}

const SendBalanceConfirmationDialog: React.FC<
  SendBalanceConfirmationDialogProps
> = ({ open, onClose, onConfirm, loading, recipientAddress, amount }) => {
  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="bg-black/40 fixed inset-0 flex items-center justify-center data-[state=open]:animate-fade-in-0.3 z-[60]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-[90%] max-w-md -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg p-6 shadow-xl z-[70] animate-fade-in-0.2">
          <div className="flex justify-between items-center mb-5">
            <Dialog.Title className="text-xl font-semibold text-grey-10 flex items-center gap-2">
              <ShieldCheck className="text-primary-50 size-6" />
              Confirm Transaction
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                onClick={onClose}
                disabled={loading}
                className="text-grey-50 hover:text-grey-30"
              >
                <Icons.CloseCircle className="size-6" />
              </button>
            </Dialog.Close>
          </div>

          <div className="mb-6 text-grey-10">
            <p className="mb-4">
              This transaction cannot be reversed once confirmed. Please review
              your transaction details carefully before confirming:
            </p>

            <div className="bg-grey-90  rounded-lg mb-4 border border-grey-80 p-4">
              <div className="flex justify-between mb-3">
                <span className="text-grey-50 font-semibold">Amount:</span>
                <span className=" text-grey-10">{amount} hALPHA</span>
              </div>

              <div className="flex justify-between items-start">
                <span className="text-grey-50 font-semibold">Recipient:</span>
                <span className=" text-grey-10 text-right max-w-[250px] break-all">
                  {`${recipientAddress.substring(
                    0,
                    12
                  )}...${recipientAddress.substring(
                    recipientAddress.length - 12
                  )}`}
                </span>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-5 py-2.5 border border-grey-80 rounded-lg text-grey-10 hover:bg-grey-95 transition"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className="px-5 py-2.5 bg-primary-50 text-white rounded-lg hover:bg-primary-40 transition disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? (
                <>
                  <span>Sending...</span>
                </>
              ) : (
                "Confirm Transfer"
              )}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default SendBalanceConfirmationDialog;

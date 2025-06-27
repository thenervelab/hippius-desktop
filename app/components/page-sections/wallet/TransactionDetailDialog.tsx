import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";

import TransactionTypeBadge from "./TransactionTypeBadge";
import { TransactionObject } from "@/app/lib/hooks/api/useBillingTransactions";
import { formatDate } from "./TransactionHistoryTable";

export interface TransactionDetailDialogProps {
  open: boolean;
  transaction: TransactionObject | null;
  onClose: () => void;
}

const TransactionDetailDialog: React.FC<TransactionDetailDialogProps> = ({
  open,
  transaction,
  onClose,
}) => (
  <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 bg-black/30 data-[state=open]:animate-fade-in-0.3" />
      <Dialog.Content className="fixed inset-0 flex items-center justify-center p-4">
        <div className="bg-white rounded shadow-lg w-full max-w-sm overflow-hidden">
          {/* Top accent bar */}
          <div className="h-4 bg-primary-50" />
          <div className="p-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <Dialog.Title className="text-base uppercase tracking-wide font-digital text-grey-40">
                Transaction Details
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  aria-label="Close"
                  className="text-grey-60 hover:text-grey-80"
                >
                  <CloseCircle className="size-6 text-grey-10" />
                </button>
              </Dialog.Close>
            </div>
            {/* Description */}
            <div className="mb-4">
              <p className="text-xs text-grey-60 uppercase">Description</p>
              <p className="text-base font-medium text-grey-20 mt-2">
                {transaction?.description}
              </p>
            </div>
            {/* Amount & ID */}
            <div className="mb-4 grid grid-cols-2 gap-x-4">
              <div>
                <p className="text-xs text-grey-60 uppercase">Amount</p>
                <p className="text-base font-medium text-grey-20 mt-2">
                  ${transaction?.amount.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-grey-60 uppercase">Transaction ID</p>
                <p className="text-base font-medium text-grey-20 mt-2">
                  {transaction?.id}
                </p>
              </div>
            </div>
            {/* Type */}
            <div className="mb-4 grid grid-cols-2 gap-x-4">
              <div>
                <p className="text-xs text-grey-60 uppercase">
                  Transaction Type
                </p>
                <div className="mt-2">
                  <TransactionTypeBadge type={transaction?.type!} />
                </div>
              </div>
              {/* Date */}
              <div>
                <p className="text-xs text-grey-60 uppercase">
                  Transaction Date
                </p>
                <p className="text-base font-medium text-grey-20 mt-2">
                  {transaction
                    ? formatDate(new Date(transaction.date), "short")
                    : ""}
                </p>
              </div>
            </div>
            {/* Download Invoice */}
            {/* <hr className="my-4 border-grey-80" />
            <button
              className="w-full flex items-center justify-center gap-x-2 px-4 py-2 border border-primary-80 bg-primary-90 text-primary-40 rounded hover:bg-primary-80"
            >
              <DocumentDownload className="size-4" />
              <span className="font-medium">Download Invoice</span>
            </button> */}
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);

export default TransactionDetailDialog;

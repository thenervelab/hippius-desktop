import { ColumnDef } from "@tanstack/react-table";
import { LocalWallet } from "@/app/lib/helpers/localWalletDb";
import { Copy, Edit2, Download, Trash2 } from "lucide-react";

// Format date helper
const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    return (
        date.toLocaleDateString("en-US", {
            month: "2-digit",
            day: "2-digit",
            year: "2-digit",
        }) +
        " " +
        date
            .toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
            })
            .toLowerCase()
    );
};

interface WalletColumnOptions {
    truncateAddress: (address: string, start?: number, end?: number) => string;
    onCopyAddress: (address: string) => void;
    onMakeActive: (walletId: number) => void;
    onEdit: (wallet: LocalWallet) => void;
    onExport: (wallet: LocalWallet) => void;
    onDelete: (wallet: LocalWallet) => void;
}

export const getWalletColumns = (options: WalletColumnOptions): ColumnDef<LocalWallet>[] => {
    const { truncateAddress, onCopyAddress, onMakeActive, onEdit, onExport, onDelete } = options;

    return [
        {
            accessorKey: "name",
            header: "Wallet",
            id: "wallet",
            cell: ({ row }) => {
                const wallet = row.original;
                return (
                    <div className="flex flex-col py-1">
                        <span className="text-sm font-medium text-grey-10">
                            {wallet.name}
                        </span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-xs text-grey-50">
                                {truncateAddress(wallet.address, 8, 8)}
                            </span>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onCopyAddress(wallet.address);
                                }}
                                className="p-0.5 text-grey-60 hover:text-primary-50 transition-colors"
                                title="Copy address"
                            >
                                <Copy className="size-3" />
                            </button>
                        </div>
                    </div>
                );
            },
        },
        {
            accessorKey: "createdAt",
            header: "Date Imported",
            id: "date_imported",
            cell: ({ row }) => {
                const wallet = row.original;
                return (
                    <span className="text-grey-50 text-sm whitespace-nowrap">
                        {formatDate(wallet.createdAt)}
                    </span>
                );
            },
        },
        {
            accessorKey: "isActive",
            header: "Status",
            id: "status",
            cell: ({ row }) => {
                const wallet = row.original;
                return (
                    <div className="flex items-center">
                        {wallet.isActive ? (
                            <span className="inline-flex items-center px-4 py-2 rounded-md text-xs font-medium text-white bg-primary-50">
                                Active Wallet
                            </span>
                        ) : (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onMakeActive(wallet.id);
                                }}
                                className="inline-flex items-center px-4 py-2 rounded-md text-xs font-medium text-grey-30 bg-white border border-grey-70 hover:bg-grey-95 hover:text-grey-20 transition-colors"
                            >
                                Make Active Wallet
                            </button>
                        )}
                    </div>
                );
            },
        },
        {
            id: "actions",
            header: "Actions",
            enableResizing: false,
            cell: ({ row }) => {
                const wallet = row.original;
                return (
                    <div className="flex items-center gap-1">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onEdit(wallet);
                            }}
                            className="p-2 text-grey-50 hover:text-primary-50 hover:bg-grey-95 rounded-lg transition-colors"
                            title="Edit name"
                        >
                            <Edit2 className="size-4" />
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onExport(wallet);
                            }}
                            className="p-2 text-grey-50 hover:text-primary-50 hover:bg-grey-95 rounded-lg transition-colors"
                            title="Export wallet"
                        >
                            <Download className="size-4" />
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete(wallet);
                            }}
                            className="p-2 text-grey-50 hover:text-error-50 hover:bg-error-95 rounded-lg transition-colors"
                            title="Delete wallet"
                        >
                            <Trash2 className="size-4" />
                        </button>
                    </div>
                );
            },
        },
    ];
};

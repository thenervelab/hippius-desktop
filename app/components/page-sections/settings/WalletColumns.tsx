import { ColumnDef } from "@tanstack/react-table";
import { LocalWallet } from "@/app/lib/helpers/localWalletDb";
import { Copy, Edit2, Download, Trash2, MoreVertical, Check } from "lucide-react";
import React, { useRef, useEffect, useState } from "react";
import TableActionMenu from "@/components/ui/alt-table/TableActionMenu";
import { Button } from "@/components/ui";

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
    onCopyAddress: (address: string) => void;
    onMakeActive: (walletId: number) => void;
    onEdit: (wallet: LocalWallet) => void;
    onExport: (wallet: LocalWallet) => void;
    onDelete: (wallet: LocalWallet) => void;
}

// Component to display address with middle truncation based on available width
const TruncatedAddress: React.FC<{ address: string; maxWidth: number }> = ({ address, maxWidth }) => {
    const [displayAddress, setDisplayAddress] = useState(address);

    useEffect(() => {
        if (maxWidth <= 0) return;

        // Create a temporary span to measure text width
        const measureSpan = document.createElement('span');
        measureSpan.style.fontSize = '14px'; // text-sm
        measureSpan.style.fontFamily = 'inherit';
        measureSpan.style.position = 'absolute';
        measureSpan.style.visibility = 'hidden';
        measureSpan.style.whiteSpace = 'nowrap';
        document.body.appendChild(measureSpan);

        // Check if full address fits
        measureSpan.textContent = address;
        const fullWidth = measureSpan.offsetWidth;

        if (fullWidth <= maxWidth) {
            // Full address fits - show it without dots
            setDisplayAddress(address);
            document.body.removeChild(measureSpan);
            return;
        }

        // Need to truncate with middle dots - find maximum chars that fit
        // Use binary search for efficiency
        let low = 4;
        let high = Math.floor(address.length / 2);
        let optimalChars = low;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const truncated = `${address.slice(0, mid)}...${address.slice(-mid)}`;
            measureSpan.textContent = truncated;

            if (measureSpan.offsetWidth <= maxWidth) {
                optimalChars = mid;
                low = mid + 1; // Try to fit more characters
            } else {
                high = mid - 1; // Need fewer characters
            }
        }

        document.body.removeChild(measureSpan);
        setDisplayAddress(`${address.slice(0, optimalChars)}...${address.slice(-optimalChars)}`);
    }, [address, maxWidth]);

    return (
        <span
            className="text-sm text-grey-60 whitespace-nowrap"
            title={address}
        >
            {displayAddress}
        </span>
    );
};

// Wrapper component that measures available width and passes it to TruncatedAddress
const AddressCell: React.FC<{ address: string; onCopy: () => void }> = ({ address, onCopy }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [maxTextWidth, setMaxTextWidth] = useState(0);
    const [isCopied, setIsCopied] = useState(false);

    useEffect(() => {
        const calculateWidth = () => {
            const container = containerRef.current;
            if (!container) return;

            // Get the button width
            const button = container.querySelector('button');
            const buttonWidth = button?.offsetWidth || 20;
            const gap = 6; // gap-1.5 = 6px

            // Available width for text = container width - button - gap
            const available = container.offsetWidth - buttonWidth - gap;
            setMaxTextWidth(Math.max(0, available));
        };

        calculateWidth();

        const observer = new ResizeObserver(calculateWidth);
        if (containerRef.current) {
            observer.observe(containerRef.current);
        }

        return () => observer.disconnect();
    }, []);

    const handleCopy = () => {
        onCopy();
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
    };

    return (
        <div ref={containerRef} className="flex items-center gap-1.5 mt-0.5 w-full">
            <TruncatedAddress address={address} maxWidth={maxTextWidth} />
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    handleCopy();
                }}
                className="p-0.5 text-grey-10 hover:text-primary-20 transition-colors flex-shrink-0"
                title="Copy address"
            >
                {isCopied ? (
                    <Check className="size-4 text-success-50" />
                ) : (
                    <Copy className="size-4" />
                )}
            </button>
        </div>
    );
};

export const getWalletColumns = (options: WalletColumnOptions): ColumnDef<LocalWallet>[] => {
    const { onCopyAddress, onMakeActive, onEdit, onExport, onDelete } = options;

    return [
        {
            accessorKey: "name",
            header: "Wallet",
            id: "wallet",
            cell: ({ row }) => {
                const wallet = row.original;
                return (
                    <div className="flex flex-col py-1 min-w-0">
                        <span className="text-base font-medium text-grey-20 truncate">
                            {wallet.name}
                        </span>
                        <AddressCell
                            address={wallet.address}
                            onCopy={() => onCopyAddress(wallet.address)}
                        />
                    </div>
                );
            },
        },
        {
            accessorKey: "createdAt",
            header: "Date",
            id: "date_imported",
            cell: ({ row }) => {
                const wallet = row.original;
                return (
                    <span className="text-grey-60 text-base font-medium whitespace-nowrap">
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
                            <span className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium text-grey-10 bg-primary-100">
                                Active Wallet
                            </span>
                        ) : (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onMakeActive(wallet.id);
                                }}
                                className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium text-grey-10 border border-grey-80 bg-grey-90 hover:bg-grey-80 transition-colors"
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
            header: "",
            enableResizing: false,
            minSize: 40,
            maxSize: 60,
            cell: ({ row }) => {
                const wallet = row.original;
                const menuItems = [
                    {
                        icon: <Edit2 className="size-4" />,
                        itemTitle: "Edit Name",
                        onItemClick: () => onEdit(wallet),
                    },
                    {
                        icon: <Download className="size-4" />,
                        itemTitle: "Export Wallet",
                        onItemClick: () => onExport(wallet),
                    },
                    {
                        icon: <Trash2 className="size-4" />,
                        itemTitle: "Delete Wallet",
                        onItemClick: () => onDelete(wallet),
                        variant: "destructive" as const,
                    },
                ];

                return (
                    <div className="flex justify-center items-center">
                        <TableActionMenu dropdownTitle="Wallet Options" items={menuItems}>
                            <Button
                                variant="ghost"
                                size="md"
                                className="h-8 w-8 p-0 text-grey-70"
                            >
                                <MoreVertical className="size-4" />
                            </Button>
                        </TableActionMenu>
                    </div>
                );
            },
        },
    ];
};

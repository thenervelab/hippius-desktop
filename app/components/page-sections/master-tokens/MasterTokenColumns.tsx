import { ColumnDef } from "@tanstack/react-table";
import { MasterToken } from "@/app/lib/types/masterToken";
import { Icons } from "@/components/ui";
import { MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import TableActionMenu from "@/components/ui/alt-table/TableActionMenu";
import { cn } from "@/lib/utils";

const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const year = String(date.getFullYear()).slice(-2);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");

    return `${month}/${day}/${year} ${hours}:${minutes}`;
};

const getExpiryStatus = (expiresAt: string) => {
    const now = new Date();
    const expiry = new Date(expiresAt);
    const daysUntilExpiry = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry < 0) {
        return { label: "Expired", variant: "expired" as const };
    } else if (daysUntilExpiry <= 7) {
        return { label: `${daysUntilExpiry}d left`, variant: "warning" as const };
    } else if (daysUntilExpiry <= 30) {
        return { label: `${daysUntilExpiry}d left`, variant: "caution" as const };
    } else {
        return { label: `${daysUntilExpiry}d left`, variant: "normal" as const };
    }
};

export const getMasterTokenColumns = (
    onRevoke: (token: MasterToken) => void,
    onRotate: (token: MasterToken) => void,
    hasActiveTokens: boolean = true
): ColumnDef<MasterToken>[] => {

    const getMenuItems = (token: MasterToken) => {
        const items = [];

        // Only show actions for active tokens
        if (token.status === "active") {
            items.push({
                icon: <Icons.Refresh className="size-4" />,
                itemTitle: "Rotate",
                onItemClick: () => onRotate(token),
            });
            items.push({
                icon: <Icons.Stop className="size-4" />,
                itemTitle: "Revoke",
                onItemClick: () => onRevoke(token),
                variant: "destructive" as const,
            });
        }

        return items;
    };

    return [
        {
            accessorKey: "name",
            header: "Token Name",
            cell: ({ row }) => {
                const token = row.original;
                return (
                    <div className="flex items-center gap-x-2">
                        <span className="text-grey-10 font-medium">{token.name}</span>
                    </div>
                );
            },
        },
        {
            accessorKey: "access_key_id",
            header: "Access Key ID",
            cell: ({ row }) => {
                const token = row.original;
                return (
                    <span className="text-grey-60 font-mono text-sm">
                        {token.access_key_id}
                    </span>
                );
            },
        },
        {
            accessorKey: "last4",
            header: "Secret (Last 4)",
            cell: ({ row }) => {
                const token = row.original;
                return (
                    <span className="text-grey-60 font-mono text-sm">
                        ****{token.last4}
                    </span>
                );
            },
        },
        {
            accessorKey: "created_at",
            header: "Created",
            cell: ({ row }) => {
                const token = row.original;
                return (
                    <span className="text-grey-60 whitespace-nowrap">
                        {formatDate(token.created_at)}
                    </span>
                );
            },
        },
        {
            accessorKey: "expires_at",
            header: "Expires",
            cell: ({ row }) => {
                const token = row.original;
                const { label, variant } = getExpiryStatus(token.expires_at);

                return (
                    <div className="flex flex-col">
                        <span className="text-grey-60 whitespace-nowrap text-sm">
                            {formatDate(token.expires_at)}
                        </span>
                        <span
                            className={cn(
                                "text-xs",
                                variant === "expired" && "text-error-50",
                                variant === "warning" && "text-warning-50",
                                variant === "caution" && "text-warning-60",
                                variant === "normal" && "text-grey-60"
                            )}
                        >
                            {label}
                        </span>
                    </div>
                );
            },
        },
        {
            accessorKey: "status",
            header: "Status",
            cell: ({ row }) => {
                const token = row.original;
                const isActive = token.status === "active";
                const isExpired = new Date(token.expires_at) < new Date();

                // Show expired state if token is expired
                if (isExpired && isActive) {
                    return (
                        <div className="flex items-center">
                            <div className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium text-grey-10 bg-error-90">
                                <span className="block p-1 rounded-full bg-error-70">
                                    <span className="block w-2 h-2 rounded-full bg-error-50" />
                                </span>
                                <span>Expired</span>
                            </div>
                        </div>
                    );
                }

                return (
                    <div className="flex items-center">
                        <div
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium text-grey-10",
                                isActive ? "bg-success-90" : "bg-grey-90"
                            )}
                        >
                            <span
                                className={cn(
                                    "block p-1 rounded-full",
                                    isActive ? "bg-success-70" : "bg-grey-80"
                                )}
                            >
                                <span
                                    className={cn(
                                        "block w-2 h-2 rounded-full",
                                        isActive ? "bg-success-50" : "bg-grey-70"
                                    )}
                                />
                            </span>
                            <span className="capitalize">{isActive ? "Active" : "Revoked"}</span>
                        </div>
                    </div>
                );
            },
        },
        // Only include actions column if there are active tokens
        ...(hasActiveTokens ? [{
            id: "actions",
            header: "",
            cell: ({ row }: { row: { original: MasterToken } }) => {
                const token = row.original;
                const menuItems = getMenuItems(token);

                // Don't show menu if no actions available (token is revoked)
                if (menuItems.length === 0) {
                    return null;
                }

                const buttonElement = (
                    <Button variant="ghost" size="md" className="h-8 w-16 p-0 text-grey-70 action-menu-area">
                        <MoreVertical className="size-4" />
                    </Button>
                );

                return (
                    <TableActionMenu dropdownTitle="Token Options" items={menuItems}>
                        {buttonElement}
                    </TableActionMenu>
                );
            },
        }] : []),
    ];
};

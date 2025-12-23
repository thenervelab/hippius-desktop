import { ColumnDef } from "@tanstack/react-table";
import { ApiToken } from "@/app/lib/types/apiToken";
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

export const getTokenColumns = (
    onRevoke: (token: ApiToken) => void,
    onRotate: (token: ApiToken) => void,
    hasActiveTokens: boolean = true
): ColumnDef<ApiToken>[] => {

    const getMenuItems = (token: ApiToken) => {
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
            id: "name",
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
            accessorKey: "appliedTo",
            header: "Applied To",
            id: "bucket_scope",
            cell: ({ row }) => {
                const token = row.original;
                return <span className="text-grey-60">{token.appliedTo || (token.scope_type === 'all_buckets' ? 'All Buckets' : `${token.buckets?.length || 0} buckets`)}</span>;
            },
        },
        {
            accessorKey: "permission",
            header: "Permission",
            id: "permission",
            cell: ({ row }) => {
                const token = row.original;
                return (
                    <span className="inline-flex items-center px-2 py-1 rounded-[4px] bg-grey-90 border border-grey-80 text-grey-10 text-xs font-medium whitespace-nowrap">
                        {token.permission}
                    </span>
                );
            },
        },
        {
            accessorKey: "created_at",
            header: "Date Created",
            id: "created_at",
            cell: ({ row }) => {
                const token = row.original;
                return (
                    <span className="text-grey-60 whitespace-nowrap">
                        {token.created_at ? formatDate(token.created_at) : "N/A"}
                    </span>
                );
            },
        },
        {
            accessorKey: "status",
            header: "Status",
            id: "expires_at",
            cell: ({ row }) => {
                const token = row.original;
                const isActive = token.status === "active";
                const isRevoked = token.status === "revoked";

                return (
                    <div className="flex items-center">
                        <div
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium text-grey-10",
                                isActive ? "bg-success-90" : isRevoked ? "bg-error-90" : "bg-grey-90"
                            )}
                        >
                            {/* Outer circle ring */}
                            <span
                                className={cn(
                                    "block p-1 rounded-full",
                                    isActive ? "bg-success-70" : isRevoked ? "bg-error-70" : "bg-grey-80"
                                )}
                            >
                                {/* Inner dot */}
                                <span
                                    className={cn(
                                        "block w-2 h-2 rounded-full",
                                        isActive ? "bg-success-50" : isRevoked ? "bg-error-50" : "bg-grey-70"
                                    )}
                                />
                            </span>
                            <span className="capitalize">{token.status}</span>
                        </div>
                    </div>
                );
            },
        },
        // Only include actions column if there are active tokens
        ...(hasActiveTokens ? [{
            id: "actions",
            header: "",
            enableResizing: false,
            cell: ({ row }: { row: { original: ApiToken } }) => {
                const token = row.original;
                const menuItems = getMenuItems(token);

                // Don't show menu if no actions available (token is revoked)
                if (menuItems.length === 0) {
                    return null;
                }

                const buttonElement = (
                    <Button
                        variant="ghost"
                        size="md"
                        className="h-8 w-8 p-0 text-grey-70 action-menu-area"
                    >
                        <MoreVertical className="size-4" />
                    </Button>
                );

                return (
                    <div className="flex justify-center items-center">
                        <TableActionMenu dropdownTitle="Token Options" items={menuItems}>
                            {buttonElement}
                        </TableActionMenu>
                    </div>
                );
            },
        }] : []),
    ];
}

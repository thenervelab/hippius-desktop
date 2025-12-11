"use client";

import React from "react";
import { MasterToken } from "@/app/lib/types/masterToken";
import {
    getCoreRowModel,
    useReactTable,
    getSortedRowModel,
} from "@tanstack/react-table";
import * as TableModule from "@/components/ui/alt-table";
import { getMasterTokenColumns } from "./MasterTokenColumns";
import NoEntriesFound from "../NoEntriesFound";
import NoMatchingResults from "@/app/components/page-sections/files/NoMatchingResults";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import usePagination from "@/lib/hooks/use-pagination";

interface MasterTokensTableProps {
    tokens: MasterToken[];
    isLoading: boolean;
    isRefetching: boolean;
    onRevoke: (token: MasterToken) => void;
    onRotate: (token: MasterToken) => void;
    hasActiveSearch: boolean;
    searchTerm: string;
    onCreateToken: () => void;
}

const MasterTokensTable: React.FC<MasterTokensTableProps> = ({
    tokens,
    isLoading,
    isRefetching,
    onRevoke,
    onRotate,
    hasActiveSearch,
    searchTerm,
    onCreateToken,
}) => {
    const ITEMS_PER_PAGE = 10;
    const { paginatedData, totalPages, currentPage, setCurrentPage } = usePagination(
        tokens,
        ITEMS_PER_PAGE
    );

    // Check if there are any active (non-revoked, non-expired) tokens
    const hasActiveTokens = tokens.some((token) => {
        if (token.status !== "active") return false;
        const expiresAt = new Date(token.expires_at);
        return expiresAt > new Date();
    });

    const columns = getMasterTokenColumns(onRevoke, onRotate, hasActiveTokens);

    const table = useReactTable({
        columns,
        data: paginatedData || [],
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
    });

    return (
        <div className="flex flex-col gap-y-8 mb-4">
            {isLoading && tokens.length === 0 ? (
                <TableModule.TableWrapper className="mt-6 duration-300">
                    <TableModule.Table>
                        <TableModule.THead>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableModule.Tr key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => (
                                        <TableModule.Th key={header.id} header={header} />
                                    ))}
                                </TableModule.Tr>
                            ))}
                        </TableModule.THead>
                        <TableModule.TBody>
                            <TableModule.SkeletonTableRow
                                rowClassName="h-[69px]"
                                rows={5}
                                columns={6}
                                columnWidths={["180px", "200px", "100px", "150px", "150px", "100px"]}
                            />
                        </TableModule.TBody>
                    </TableModule.Table>
                </TableModule.TableWrapper>
            ) : !tokens.length ? (
                <div className="mt-6 duration-300">
                    {hasActiveSearch ? (
                        <NoMatchingResults
                            searchTerm={searchTerm}
                            hasActiveFilters={false}
                            entityType="master-token"
                        />
                    ) : (
                        <NoEntriesFound
                            text="Create Master Token"
                            isLoading={false}
                            callCreateObjectOrBucket={onCreateToken}
                            storageType="token"
                        />
                    )}
                </div>
            ) : (
                <TableModule.TableWrapper className="mt-6 duration-300">
                    <TableModule.Table>
                        <TableModule.THead>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableModule.Tr key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => (
                                        <TableModule.Th key={header.id} header={header} />
                                    ))}
                                </TableModule.Tr>
                            ))}
                        </TableModule.THead>

                        <TableModule.TBody>
                            {isRefetching && (
                                <tr className="absolute inset-0 bg-grey-100/50 backdrop-blur-sm z-10">
                                    <td className="h-full flex items-center justify-center">
                                        <div className="animate-spin">
                                            <Icons.Loader className="size-8 text-primary-50" />
                                        </div>
                                    </td>
                                </tr>
                            )}
                            {table.getRowModel().rows?.map((row) => {
                                return (
                                    <TableModule.Tr
                                        rowHover
                                        key={`${row.id}`}
                                        transparent
                                    >
                                        {row.getVisibleCells().map((cell) => (
                                            <TableModule.Td
                                                className={cn(cell.column.id === "actions" && "w-8")}
                                                key={cell.id}
                                                cell={cell}
                                            />
                                        ))}
                                    </TableModule.Tr>
                                );
                            })}
                        </TableModule.TBody>
                    </TableModule.Table>
                </TableModule.TableWrapper>
            )}

            {totalPages > 1 && (
                <TableModule.Pagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    setPage={setCurrentPage}
                />
            )}
        </div>
    );
};

export default MasterTokensTable;

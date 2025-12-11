"use client";

import React from "react";
import { ApiToken } from "@/app/lib/types/apiToken";
import {
    getCoreRowModel,
    useReactTable,
    getSortedRowModel,
} from "@tanstack/react-table";
import * as TableModule from "@/components/ui/alt-table";
import { getTokenColumns } from "./TokenColumns";
import NoEntriesFound from "@/app/components/page-sections/NoEntriesFound";
import NoMatchingResults from "@/components/page-sections/files/ipfs/NoMatchingResults";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import usePagination from "@/lib/hooks/use-pagination";

interface ApiTokensTableProps {
    tokens: ApiToken[];
    isLoading: boolean;
    isRefetching: boolean;
    onRevoke: (token: ApiToken) => void;
    onRotate: (token: ApiToken) => void;
    hasActiveSearch: boolean;
    searchTerm: string;
    onCreateToken: () => void;
}

const ApiTokensTable: React.FC<ApiTokensTableProps> = ({
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

    // Check if there are any active (non-revoked) tokens
    const hasActiveTokens = tokens.some((token) => token.status === "active");

    const columns = getTokenColumns(onRevoke, onRotate, hasActiveTokens);

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
                                rows={8}
                                columns={columns.length}
                                columnWidths={["200px", "150px", "180px", "150px", "100px", "80px"]}
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
                            entityType="api-token"
                        />
                    ) : (
                        <NoEntriesFound
                            text="Create Token"
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

            {
                totalPages > 1 && (
                    <TableModule.Pagination
                        currentPage={currentPage}
                        totalPages={totalPages}
                        setPage={setCurrentPage}
                    />
                )
            }
        </div >
    );
};

export default ApiTokensTable;

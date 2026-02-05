"use client";

import React, { useState, useCallback, useEffect } from "react";
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

    // Default column widths for master tokens table
    const DEFAULT_COLUMN_WIDTHS = {
        name: 18,
        access_key_id: 22,
        status: 18,
        created_at: 18,
        expires_at: 15,
        status_display: 15,
        actions: 5,
    };

    const MIN_COLUMN_WIDTHS = {
        name: 15,
        access_key_id: 15,
        status: 15,
        created_at: 12,
        expires_at: 12,
        status_display: 12,
        actions: 5,
    };

    const [columnWidths, setColumnWidths] = useState(() => {
        if (typeof window === "undefined") return DEFAULT_COLUMN_WIDTHS;
        try {
            const stored = localStorage.getItem('masterTokensTable_columnWidths');
            return stored ? JSON.parse(stored) : DEFAULT_COLUMN_WIDTHS;
        } catch {
            return DEFAULT_COLUMN_WIDTHS;
        }
    });

    const [isResizing, setIsResizing] = useState(false);
    const [resizeData, setResizeData] = useState<{
        columnId: string;
        startX: number;
        startWidth: number;
        nextColumnId: string;
        nextStartWidth: number;
    } | null>(null);
    const [justResized, setJustResized] = useState(false);

    // Save column widths to localStorage
    useEffect(() => {
        const timeoutId = setTimeout(() => {
            try {
                localStorage.setItem('masterTokensTable_columnWidths', JSON.stringify(columnWidths));
            } catch { }
        }, 300);
        return () => clearTimeout(timeoutId);
    }, [columnWidths]);

    const handleResizeStart = useCallback((columnId: string, startX: number) => {
        const columnIds = Object.keys(columnWidths);
        const currentIndex = columnIds.indexOf(columnId);
        const nextColumnId = columnIds[currentIndex + 1];

        if (nextColumnId && columnId !== 'actions') {
            setIsResizing(true);
            setResizeData({
                columnId,
                startX,
                startWidth: columnWidths[columnId],
                nextColumnId,
                nextStartWidth: columnWidths[nextColumnId],
            });
        }
    }, [columnWidths]);

    const handleResizeMove = useCallback((clientX: number) => {
        if (!resizeData || !isResizing) return;

        requestAnimationFrame(() => {
            const diff = clientX - resizeData.startX;
            const standardTableWidth = 1200;
            const sensitivity = 2.2;
            const diffPercent = (diff / standardTableWidth) * 100 * sensitivity;

            const proposedCurrentWidth = resizeData.startWidth + diffPercent;
            const proposedNextWidth = resizeData.nextStartWidth - diffPercent;

            const currentMinWidth = MIN_COLUMN_WIDTHS[resizeData.columnId as keyof typeof MIN_COLUMN_WIDTHS] || 8;
            const nextMinWidth = MIN_COLUMN_WIDTHS[resizeData.nextColumnId as keyof typeof MIN_COLUMN_WIDTHS] || 8;

            // Enforce minimum widths strictly
            let newCurrentWidth = proposedCurrentWidth;
            let newNextWidth = proposedNextWidth;

            // Check if either column would go below minimum
            if (proposedCurrentWidth < currentMinWidth) {
                newCurrentWidth = currentMinWidth;
                newNextWidth = resizeData.startWidth + resizeData.nextStartWidth - currentMinWidth;
            } else if (proposedNextWidth < nextMinWidth) {
                newNextWidth = nextMinWidth;
                newCurrentWidth = resizeData.startWidth + resizeData.nextStartWidth - nextMinWidth;
            }

            // Apply maximum constraint
            newCurrentWidth = Math.min(60, newCurrentWidth);
            newNextWidth = Math.min(60, newNextWidth);

            // Only update if both columns are within valid range
            if (newCurrentWidth >= currentMinWidth && newNextWidth >= nextMinWidth) {
                setColumnWidths((prev: Record<string, number>) => ({
                    ...prev,
                    [resizeData.columnId]: newCurrentWidth,
                    [resizeData.nextColumnId]: newNextWidth,
                }));
            }
        });
    }, [resizeData, isResizing]);

    const handleResizeEnd = useCallback(() => {
        setIsResizing(false);
        setResizeData(null);
        setJustResized(true);
        setTimeout(() => {
            setJustResized(false);
        }, 100);
    }, []);

    useEffect(() => {
        if (!isResizing) return;

        const handleMouseMove = (e: MouseEvent) => handleResizeMove(e.clientX);
        const handleMouseUp = () => handleResizeEnd();

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing, handleResizeMove, handleResizeEnd]);

    const table = useReactTable({
        columns,
        data: paginatedData || [],
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        enableColumnResizing: true,
    });

    return (
        <div className="flex flex-col gap-y-8 mb-4">
            {isLoading && tokens.length === 0 ? (
                <TableModule.TableWrapper className="mt-6 duration-300">
                    <TableModule.Table className="w-full table-fixed">
                        <TableModule.THead>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableModule.Tr key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => (
                                        <TableModule.Th
                                            key={header.id}
                                            header={header}
                                            columnWidth={columnWidths[header.id]}
                                            onResizeStart={handleResizeStart}
                                            preventSort={justResized}
                                        />
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
                    <TableModule.Table className="w-full table-fixed">
                        <TableModule.THead>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableModule.Tr key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => (
                                        <TableModule.Th
                                            key={header.id}
                                            header={header}
                                            columnWidth={columnWidths[header.id]}
                                            onResizeStart={handleResizeStart}
                                            preventSort={justResized}
                                        />
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
                                                columnWidth={columnWidths[cell.column.id]}
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

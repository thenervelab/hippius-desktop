"use client";

import React, { useMemo } from "react";
import { AlertCircle, Ticket, MoreVertical } from "lucide-react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";

import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import StatusBadge from "./StatusBadge";
import CategoryBadge from "./CategoryBadge";
import { SupportTicket } from "@/app/lib/hooks/useSupportTickets";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { Eye, TickSquare } from "../../ui/icons";
import {
  Pagination,
  Table,
  TableWrapper,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "../../ui/alt-table";

import { SkeletonTableRow } from "../../ui/alt-table/SkeletonTableRow";
import { Button } from "../../ui/button/NewButton";

const columnHelper = createColumnHelper<SupportTicket>();

const statusOrder: { [key: string]: number } = {
  open: 0,
  "in progress": 1,
  closed: 2,
  resolved: 3,
};

export const getSeverityColor = (severity: string) => {
  switch (severity.toLowerCase()) {
    case "low":
      return "text-grey-60";
    case "normal":
      return "text-blue-500";
    case "high":
      return "text-warning-50";
    case "urgent":
      return "text-error-60";
    default:
      return "text-grey-70";
  }
};
interface TicketsTableProps {
  data?: SupportTicket[];
  isLoading?: boolean;
  isError?: boolean;
  isRefreshing?: boolean;
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  onViewMessages?: (ticket: SupportTicket) => void;
  onCloseTicket?: (ticket: SupportTicket) => void;
}

const TicketsTable: React.FC<TicketsTableProps> = ({
  data = [],
  isLoading = false,
  isError = false,
  isRefreshing = false,
  currentPage = 1,
  totalPages = 1,
  onPageChange,
  onViewMessages,
  onCloseTicket,
}) => {
  const formatSeverity = (severity: string) => {
    return severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase();
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor("subject", {
        header: "TICKET SUBJECT",
        cell: ({ getValue, row }) => {
          const subject = getValue();
          const ticket = row.original;
          return (
            <button
              onClick={() => onViewMessages?.(ticket)}
              className="text-grey-20 text-left hover:underline cursor-pointer"
            >
              {subject}
            </button>
          );
        },
        enableSorting: false,
      }),
      columnHelper.accessor("status", {
        header: "STATUS",
        cell: (d) => {
          const status = d.getValue();
          return <StatusBadge status={status} />;
        },
        enableSorting: true,
        sortingFn: (rowA, rowB, columnId) => {
          const statusA = rowA.getValue(columnId) as string;
          const statusB = rowB.getValue(columnId) as string;
          const orderA = statusOrder[statusA.toLowerCase()] ?? 999;
          const orderB = statusOrder[statusB.toLowerCase()] ?? 999;
          return orderA - orderB;
        },
      }),
      columnHelper.accessor("category", {
        header: "CATEGORY",
        cell: (d) => {
          const category = d.getValue();
          return <CategoryBadge category={category} />;
        },
        enableSorting: false,
      }),
      columnHelper.display({
        id: "severity",
        header: "SEVERITY",
        cell: ({ row }) => {
          const severity = row.original.priority || "medium";
          return (
            <span className={cn("font-medium", getSeverityColor(severity))}>
              {formatSeverity(severity)}
            </span>
          );
        },
        enableSorting: false,
      }),
      columnHelper.accessor("created_at", {
        header: "CREATED AT",
        cell: (d) => formatDate(d.getValue()),
        enableSorting: true,
      }),
      columnHelper.display({
        id: "actions",
        header: "",
        size: 80,
        meta: {
          cellClassName: "w-[5rem] max-w-[5rem]",
          headerClassName: "w-[5rem] max-w-[5rem]",
        },
        cell: ({ row }) => {
          const ticket = row.original;
          const menuItems = [];

          // View Messages option
          if (onViewMessages) {
            menuItems.push({
              icon: <Eye className="size-4" />,
              itemTitle: "View Messages",
              onItemClick: () => onViewMessages(ticket),
            });
          }

          // Close Ticket option - only show if ticket is not already closed
          if (onCloseTicket && ticket.status !== "closed") {
            menuItems.push({
              icon: <TickSquare className="size-4" />,
              itemTitle: "Close Ticket",
              onItemClick: () => onCloseTicket(ticket),
            });
          }

          // Only show menu if there are items
          if (menuItems.length === 0) return null;

          return (
            <TableActionMenu dropdownTitle="Ticket Options" items={menuItems}>
              <Button variant="ghost" size="icon" className="text-grey-70">
                <MoreVertical className="size-4" />
              </Button>
            </TableActionMenu>
          );
        },
      }),
    ],
    [onViewMessages, onCloseTicket]
  );

  const table = useReactTable({
    columns,
    data: data || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <TableWrapper className="mt-5">
        {isError ? (
          <div className="p-6 w-full h-[21.875rem] flex items-center justify-center">
            <div className="flex flex-col animate-fade-in-0.5 items-center opacity-0">
              <AbstractIconWrapper className="size-10 rounded-2xl flex items-center justify-center bg-grey-40/20 mb-2">
                <AlertCircle className="absolute size-6 text-red-400" />
              </AbstractIconWrapper>
              <span className="text-grey-60 text-sm font-medium max-w-[11.875rem] text-center">
                Failed to get data
              </span>
            </div>
          </div>
        ) : isLoading || isRefreshing ? (
          <Table>
            <THead>
              {table.getHeaderGroups().map((headerGroup) => (
                <Tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <Th key={header.id} header={header} />
                  ))}
                </Tr>
              ))}
            </THead>
            <TBody>
              <SkeletonTableRow
                rowClassName="h-[4.3125rem]"
                rows={10}
                columns={columns.length}
                columnWidths={[
                  "18.75rem",
                  "9.375rem",
                  "9.375rem",
                  "7.5rem",
                  "11.25rem",
                  "5rem",
                ]}
              />
            </TBody>
          </Table>
        ) : !data || data.length === 0 ? (
          <div className="w-full h-[21.875rem] flex items-center justify-center p-6">
            <div className="flex flex-col animate-fade-in-0.5 items-center opacity-0">
              <AbstractIconWrapper className="size-10 rounded-2xl flex items-center justify-center bg-grey-40/20 mb-2">
                <Ticket className="absolute size-6" />
              </AbstractIconWrapper>
              <span className="text-grey-60 text-sm font-medium max-w-[11.875rem] text-center">
                You have no support tickets yet
              </span>
            </div>
          </div>
        ) : (
          <Table>
            <THead>
              {table.getHeaderGroups().map((headerGroup) => (
                <Tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <Th key={header.id} header={header} />
                  ))}
                </Tr>
              ))}
            </THead>

            <TBody>
              {table.getRowModel().rows?.map((row) => {
                const ticket = row.original;
                const shouldHighlight =
                  ticket.status === "open" && !ticket.last_staff_reply_at;
                return (
                  <Tr
                    key={row.id}
                    transparent
                    className={cn(
                      shouldHighlight &&
                        "bg-primary-70/10 hover:bg-primary-70/20 border-l-[0.375rem]  border-l-primary-50"
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <Td key={cell.id} cell={cell} />
                    ))}
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </TableWrapper>

      {totalPages > 1 && (
        <div className="my-8">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            setPage={onPageChange || (() => {})}
          />
        </div>
      )}
    </>
  );
};

export default TicketsTable;

"use client";

import React, { useMemo, useState } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Table,
  TableWrapper,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  Pagination,
  MiniPaginationControl,
  SkeletonTableRow,
} from "@/components/ui/table";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import NoEntriesFound from "@/components/ui/NoEntriesFound";
import StatusBadge from "./StatusBadge";
import CategoryBadge from "./CategoryBadge";
import PriorityBadge from "./PriorityBadge";
import { SupportTicket } from "@/app/lib/hooks/useSupportTickets";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { Eye, TickSquare, EllipsisVertical } from "../../ui/icons";
import { Button } from "../../ui/button/NewButton";

const HEADERS = [
  "TICKET SUBJECT",
  "STATUS",
  "CATEGORY",
  "STATUS",
  "DATE CREATED",
  "",
];
const SKEL_WIDTHS = ["220px", "80px", "140px", "60px", "120px", "20px"];
const MIN_W = "min-w-[640px] sm:min-w-[820px]";

const statusOrder: { [key: string]: number } = {
  open: 0,
  pending: 1,
  in_progress: 1,
  resolved: 2,
  closed: 3,
};

const formatDate = (dateString: string): string => {
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${dd}/${mm}/${yy} ${hours}:${minutes}${ampm}`;
};

const col = createColumnHelper<SupportTicket>();

interface TicketsTableProps {
  data?: SupportTicket[];
  isLoading?: boolean;
  isError?: boolean;
  isRefreshing?: boolean;
  currentPage?: number;
  totalPages?: number;
  totalCount?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  onViewMessages?: (ticket: SupportTicket) => void;
  onCloseTicket?: (ticket: SupportTicket) => void;
  /** Click handler for the "+ New Ticket" CTA inside the empty state. */
  onCreateTicket?: () => void;
}

const TicketsTable: React.FC<TicketsTableProps> = ({
  data = [],
  isLoading = false,
  isError = false,
  isRefreshing = false,
  currentPage = 1,
  totalPages = 1,
  totalCount = 0,
  pageSize = 10,
  onPageChange,
  onPageSizeChange,
  onViewMessages,
  onCloseTicket,
  onCreateTicket,
}) => {
  // Tracks which row's 3-dot action menu is open so we can pin the row's
  // hover/active background while the menu is visible (the menu portals
  // out of the row, so without this the row "un-hovers" the moment the
  // user moves the cursor into the menu).
  const [openMenuRowId, setOpenMenuRowId] = useState<number | null>(null);

  const columns = useMemo(
    () => [
      col.accessor("subject", {
        header: "TICKET SUBJECT",
        enableSorting: false,
        cell: ({ getValue, row }) => {
          const subject = getValue();
          const ticket = row.original;
          return (
            <button
              type="button"
              onClick={() => onViewMessages?.(ticket)}
              title={subject}
              className={cn(
                "block w-full truncate text-left text-[12px] font-medium leading-[18px] tracking-[-0.24px]",
                "text-grey-10 dark:text-grey-dark-200 hover:text-primary-50 dark:hover:text-primary-brand-dark transition-colors"
              )}
            >
              {subject}
            </button>
          );
        },
      }),
      col.accessor("status", {
        header: "STATUS",
        enableSorting: true,
        sortingFn: (a, b, colId) => {
          const av = a.getValue(colId) as string;
          const bv = b.getValue(colId) as string;
          return (
            (statusOrder[av?.toLowerCase()] ?? 999) -
            (statusOrder[bv?.toLowerCase()] ?? 999)
          );
        },
        cell: (d) => <StatusBadge status={d.getValue()} />,
      }),
      col.accessor("category", {
        header: "CATEGORY",
        enableSorting: false,
        cell: (d) => <CategoryBadge category={d.getValue()} />,
      }),
      col.display({
        id: "priority",
        header: "STATUS",
        enableSorting: false,
        cell: ({ row }) => (
          <PriorityBadge priority={row.original.priority || "normal"} />
        ),
      }),
      col.accessor("created_at", {
        header: "DATE CREATED",
        enableSorting: true,
        cell: (d) => (
          <span className="font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-grey-dark-800 dark:text-grey-dark-500">
            {formatDate(d.getValue())}
          </span>
        ),
      }),
      col.display({
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const ticket = row.original;
          const items = [];
          if (onViewMessages) {
            items.push({
              icon: <Eye className="size-4" />,
              itemTitle: "View Messages",
              onItemClick: () => onViewMessages(ticket),
            });
          }
          if (onCloseTicket && ticket.status !== "closed") {
            items.push({
              icon: <TickSquare className="size-4" />,
              itemTitle: "Close Ticket",
              onItemClick: () => onCloseTicket(ticket),
            });
          }
          if (items.length === 0) return null;
          const isOpen = openMenuRowId === ticket.id;
          return (
            <div className="flex justify-center">
              <TableActionMenu
                dropdownTitle=""
                items={items}
                open={isOpen}
                onOpenChange={(next) =>
                  setOpenMenuRowId(next ? ticket.id : null)
                }
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-grey-50 hover:text-grey-10 dark:text-grey-dark-600 dark:hover:text-white"
                  aria-label="Ticket actions"
                >
                  <EllipsisVertical className="size-4" />
                </Button>
              </TableActionMenu>
            </div>
          );
        },
      }),
    ],
    [onViewMessages, onCloseTicket, openMenuRowId]
  );

  const table = useReactTable({
    columns,
    data: data || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // ── Error state ────────────────────────────────────────────────────────
  if (isError) {
    return (
      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="flex h-[21.875rem] w-full items-center justify-center p-6">
          <div className="flex flex-col items-center opacity-0 animate-fade-in-0.5">
            <AbstractIconWrapper className="size-10 rounded-2xl bg-grey-40/20 mb-2">
              <AlertCircle className="absolute size-6 text-red-400" />
            </AbstractIconWrapper>
            <span className="text-grey-60 dark:text-grey-dark-600 text-sm font-medium max-w-[16.25rem] text-center">
              Failed to load support tickets
            </span>
          </div>
        </div>
      </TableWrapper>
    );
  }

  // ── Loading / refreshing state ─────────────────────────────────────────
  if (isLoading || isRefreshing) {
    return (
      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="overflow-x-auto custom-scrollbar-thin">
          <Table className={MIN_W}>
            <THead>
              <Tr>
                {HEADERS.map((h, i) => (
                  <th
                    key={`${h}-${i}`}
                    className="h-[var(--table-row-height,36px)] border-b border-r border-[#E3E3E3] bg-white px-[var(--table-cell-padding-x,10px)] py-0 text-left text-[length:var(--table-header-font-size,10px)] font-semibold uppercase text-grey-dark-600 last:border-r-0 dark:border-[#313131] dark:!bg-[#111111] dark:text-grey-dark-700"
                  >
                    {h}
                  </th>
                ))}
              </Tr>
            </THead>
            <TBody>
              <SkeletonTableRow
                rows={pageSize}
                columns={HEADERS.length}
                columnWidths={SKEL_WIDTHS}
                rowClassName="odd:bg-[#fbfbfb] even:bg-[#f5f5f5] dark:odd:bg-[#161616] dark:even:bg-[#1e1e1e]"
                cellClassName="!border-[#E3E3E3] dark:!border-[#313131]"
              />
            </TBody>
          </Table>
        </div>
      </TableWrapper>
    );
  }

  // ── Empty state ────────────────────────────────────────────────────────
  if (!data || data.length === 0) {
    return (
      <NoEntriesFound
        title="No support tickets yet"
        description="Submit a ticket and our team will respond as soon as possible. Click '+ New Ticket' to start a conversation."
        buttonText="+ New Ticket"
        onButtonClick={onCreateTicket}
        cardView={false}
        className="!bg-white dark:!bg-black-600 p-4 sm:p-8"
      />
    );
  }

  // ── Loaded ─────────────────────────────────────────────────────────────
  return (
    <>
      {totalCount > pageSize && (
        <div className="flex justify-end px-3 pt-3 mb-3">
          <MiniPaginationControl
            currentPage={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            totalCount={totalCount}
            onPrev={() =>
              onPageChange?.(Math.max(1, currentPage - 1))
            }
            onNext={() =>
              onPageChange?.(Math.min(totalPages, currentPage + 1))
            }
          />
        </div>
      )}

      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="overflow-x-auto custom-scrollbar-thin">
          <Table className={MIN_W}>
            <THead>
              {table.getHeaderGroups().map((hg) => (
                <Tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <Th
                      key={h.id}
                      header={h}
                      className="bg-white dark:!bg-[#111111] !border-[#E3E3E3] dark:!border-[#313131]"
                    />
                  ))}
                </Tr>
              ))}
            </THead>
            <TBody>
              {table.getRowModel().rows.map((row) => {
                const isMenuOpen = openMenuRowId === row.original.id;
                // When the row's menu is open we pin the active bg so it
                // reads as "currently being acted on". Otherwise we keep
                // the zebra striping and add a hover variant via the
                // group/ticket-row name.
                const rowBgClass = isMenuOpen
                  ? "bg-[#f1f1f1] dark:bg-black-primary-bg/70"
                  : row.index % 2 === 0
                    ? "bg-[#fbfbfb] dark:bg-[#161616]"
                    : "bg-[#f5f5f5] dark:bg-[#1e1e1e]";
                return (
                  <Tr key={row.id} className="group/ticket-row">
                    {row.getVisibleCells().map((cell) => (
                      <Td
                        key={cell.id}
                        cell={cell}
                        className={cn(
                          "transition-colors",
                          "!border-[#E3E3E3] dark:!border-[#313131]",
                          rowBgClass,
                          !isMenuOpen &&
                            "group-hover/ticket-row:bg-[#f1f1f1] dark:group-hover/ticket-row:bg-black-primary-bg/70"
                        )}
                      />
                    ))}
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </div>
      </TableWrapper>

      {totalCount > pageSize && (
        <div className="px-3 pb-3 mt-3">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            setPage={(p) => onPageChange?.(p)}
            totalCount={totalCount}
            pageSize={pageSize}
            setPageSize={(s) => onPageSizeChange?.(s)}
          />
        </div>
      )}
    </>
  );
};

export default TicketsTable;

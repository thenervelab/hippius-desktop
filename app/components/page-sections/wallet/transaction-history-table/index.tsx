import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";

import { useEffect, useState, useMemo } from "react";
import {
  TableWrapper,
  Table,
  Tr,
  Td,
  Th,
  THead,
  TBody,
} from "@/components/ui/alt-table";
import { Loader2 } from "lucide-react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { Dollar, ArrowCircleDown } from "@/components/ui/icons";
import TransactionDetailDialog from "./TransactionDetailDialog";
import TransactionTypeBadge from "./TransactionTypeBadge";
import useBillingTransactions, {
  TransactionObject,
} from "@/app/lib/hooks/api/useBillingTransactions";

export const formatDate = (
  date: Date,
  variant: "long" | "short" = "long"
): string => {
  if (variant === "long") {
    return date
      .toLocaleString("en-US", {
        month: "long",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
      .replace("AM", "am")
      .replace("PM", "pm");
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
    .format(date)
    .replace(",", "")
    .toLowerCase();
};

const columnHelper = createColumnHelper<TransactionObject>();

const TransactionHistoryTable: React.FC = () => {
  const { data: transactions, isPending } = useBillingTransactions();

  const [init, setInit] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedRow, setSelectedRow] = useState<TransactionObject | null>(
    null
  );

  useEffect(() => {
    // getTransactions();
    setInit(true);

    const mql = window.matchMedia("(max-width: 768px)");
    setIsMobile(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const baseColumns = useMemo(
    () => [
      //   columnHelper.accessor("id", {
      //     id: "ID",
      //     header: "ID",
      //     cell: (d) => d.getValue(),
      //   }),
      columnHelper.accessor("amount", {
        id: "amount",
        header: "AMOUNT",
        cell: (d) => `$ ${d.getValue().toLocaleString()}`,
        enableSorting: true,
      }),
      columnHelper.accessor("type", {
        id: "type",
        header: "TRANSACTION TYPE",
        cell: (d) => <TransactionTypeBadge type={d.getValue()} />,
      }),
      columnHelper.accessor("date", {
        id: "date",
        header: "TRANSACTION DATE",
        cell: (d) => formatDate(new Date(d.getValue())),
        enableSorting: true,
      }),
    ],
    []
  );

  const mobileColumns = useMemo(
    () => [
      columnHelper.accessor("description", {
        id: "description",
        header: "DESCRIPTION",
        cell: (d) => (
          <div className="text-grey-20 text-base">{d.getValue()}</div>
        ),
        enableSorting: true,
      }),
      baseColumns.find((c) => c.id === "amount")!,
      columnHelper.display({
        id: "expand",
        header: "",
        cell: ({ row }) => (
          <div className="flex items-center justify-center">
            <button
              onClick={() => {
                console.log("selected row", row.original);
                setSelectedRow(row.original);
              }}
            >
              <ArrowCircleDown className="size-4 text-grey-10" />
            </button>
          </div>
        ),
      }),
    ],
    [baseColumns]
  );

  const columns = isMobile ? mobileColumns : baseColumns;

  const table = useReactTable({
    columns,
    data: transactions || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <TableWrapper className="mt-5">
        <Table>
          <THead>
            {table.getHeaderGroups().map((hg) => (
              <Tr key={hg.id}>
                {hg.headers.map((h) => (
                  <Th key={h.id} header={h} />
                ))}
              </Tr>
            ))}
          </THead>
          <TBody>
            {table.getRowModel().rows.map((row) => (
              <Tr key={row.id} transparent>
                {row.getVisibleCells().map((cell) => (
                  <Td key={cell.id} cell={cell} />
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>

        {isPending && (
          <div className="w-full h-[350px] flex items-center justify-center p-6 animate-fade-in-0.3 opacity-0">
            <Loader2 className="size-6 animate-spin text-grey-50" />
          </div>
        )}

        {init && transactions && !transactions.length && (
          <div className="w-full h-[350px] flex items-center justify-center p-6">
            <div className="flex flex-col items-center opacity-0 animate-fade-in-0.5">
              <AbstractIconWrapper className="size-10 rounded-2xl bg-grey-40/20 mb-2">
                <Dollar className="absolute size-6" />
              </AbstractIconWrapper>
              <span className="text-grey-60 text-sm font-medium max-w-[190px] text-center">
                You have not made a transaction yet
              </span>
            </div>
          </div>
        )}
      </TableWrapper>

      <TransactionDetailDialog
        open={Boolean(selectedRow)}
        transaction={selectedRow}
        onClose={() => setSelectedRow(null)}
      />
    </>
  );
};

export default TransactionHistoryTable;

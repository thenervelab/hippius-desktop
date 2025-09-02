import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import {
  TableWrapper,
  Table,
  Tr,
  Td,
  Th,
  THead,
  TBody,
  Pagination,
  CopyableCell
} from "@/components/ui/alt-table";
import { Loader2 } from "lucide-react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { Dollar, TaoLogo } from "@/components/ui/icons";
import TransactionTypeBadge from "./TransactionTypeBadge";
import useBillingTransactions, { TransactionObject } from "@/app/lib/hooks/api/useBillingTransactions";
import StatusTypeBadge from "./StatusTypeBadge";

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
        hour12: true
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
    hour12: true
  })
    .format(date)
    .replace(",", "")
    .toLowerCase();
};

const columnHelper = createColumnHelper<TransactionObject>();
const ITEMS_PER_PAGE = 10;

const BillingHistoryTable: React.FC = () => {
  const { data: transactions, isPending, error } = useBillingTransactions();

  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = useMemo(
    () => Math.ceil((transactions?.length || 0) / ITEMS_PER_PAGE),
    [transactions?.length]
  );

  const paginatedData = useMemo(() => {
    if (!transactions) return [];
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return transactions.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [transactions, currentPage]);

  const baseColumns = useMemo(
    () => [
      columnHelper.accessor("id", {
        id: "id",
        header: "ID",
        cell: (info) => (
          <CopyableCell
            copyAbleText={info.getValue() as string}
            title="Copy Billing ID"
            toastMessage="Billing ID Copied Successfully!"
            isTable={true}
          />
        ),
        enableSorting: true
      }),
      columnHelper.accessor("amount", {
        id: "amount",
        header: "AMOUNT",
        cell: (d) => {
          return <div className="flex items-center gap-x-1">
            {(d.row.original.transaction_type === "tao" ? <TaoLogo className="size-2.5" /> : "$")}
            <span>{d.getValue().toLocaleString()}</span>
          </div>;
        },
        enableSorting: true,
      }),
      columnHelper.accessor("transaction_type", {
        id: "transaction_type",
        header: "TRANSACTION TYPE",
        cell: (d) => {
          const type = d.getValue();
          const validType = type === "tao" || type === "card" ? type : null;
          return <TransactionTypeBadge type={validType} />;
        },
      }),
      columnHelper.accessor("status", {
        id: "status",
        header: "STATUS",
        cell: (d) => {
          const status = d.getValue();
          const validStatus = (status === "failed" || status === "success" || status === "completed" || status === "pending") ? status : null;
          return <StatusTypeBadge type={validStatus} />;
        },
      }),
      columnHelper.accessor("transaction_date", {
        id: "date",
        header: "TRANSACTION DATE",
        cell: (d) => formatDate(new Date(d.getValue())),
        enableSorting: true
      })
    ],
    []
  );

  const columns = baseColumns;

  const table = useReactTable({
    columns,
    data: paginatedData,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  return (
    <>
      <TableWrapper>
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
                  <Td className="text-grey-20" key={cell.id} cell={cell} />
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>

        {((isPending) && !error) && (
          <div className="w-full h-[350px] flex items-center justify-center p-6 animate-fade-in-0.3">
            <Loader2 className="size-6 animate-spin text-grey-50" />
          </div>
        )}

        {((transactions && !transactions.length) || error) && !isPending && transactions !== null && (
          <div className="w-full h-[350px] flex items-center justify-center p-6">
            <div className="flex flex-col items-center opacity-0 animate-fade-in-0.5">
              <AbstractIconWrapper className="size-10 rounded-2xl bg-grey-40/20 mb-2">
                <Dollar className="absolute size-6" />
              </AbstractIconWrapper>
              <span className="text-grey-60 text-sm font-medium max-w-[260px] text-center">
                {error ? `Unable to load billing history: ${error}` : "You do not have any billing history yet"}
              </span>
            </div>
          </div>
        )}
      </TableWrapper>

      {totalPages > 1 && (
        <div className="my-4">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            setPage={setCurrentPage}
          />
        </div>
      )}
    </>
  );
};

export default BillingHistoryTable;

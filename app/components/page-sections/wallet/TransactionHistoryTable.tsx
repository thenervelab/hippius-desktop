import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
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
  CopyableCell,
  Pagination,
} from "@/components/ui/alt-table";
import { Loader2 } from "lucide-react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { Dollar } from "@/components/ui/icons";
import { TransactionObject } from "@/app/lib/hooks/api/useBalanceTransactions";
import { formatBalance } from "@/app/lib/utils/formatters/formatBalance";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

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
const ITEMS_PER_PAGE = 10;
interface TransactionHistoryTableProps {
  transactions: TransactionObject[] | undefined;
  isPending: boolean;
}

const TransactionHistoryTable: React.FC<TransactionHistoryTableProps> = ({
  transactions,
  isPending,
}) => {
  const { polkadotAddress } = useWalletAuth();
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
      columnHelper.accessor("block", {
        id: "block",
        header: "BLOCK",
        cell: (d) => d.getValue(),
        enableSorting: true,
      }),
      columnHelper.accessor("amount", {
        id: "amount",
        header: () => (
          <span>
            AMOUNT (<span className="!normal-case">hALPHA</span>)
          </span>
        ),
        cell: (d) => `${formatBalance(d.getValue(), 6)}`,
        enableSorting: true,
      }),
      columnHelper.accessor("from", {
        id: "from",
        header: "FROM",
        cell: (info) => (
          <CopyableCell
            copyAbleText={info.getValue()}
            title="Copy Account"
            toastMessage="Account Copied Successfully!"
            isTable={true}
          />
        ),
        meta: {
          cellClassName: "lg:max-w-[400px] lg:min-w-[400px] lg:w-[400px]",
        },
      }),

      columnHelper.accessor("to", {
        id: "to",
        header: "TO",
        cell: (info) => (
          <CopyableCell
            copyAbleText={info.getValue()}
            title="Copy Account"
            toastMessage="Account Copied Successfully!"
            isTable={true}
          />
        ),
        meta: {
          cellClassName: "lg:max-w-[400px] lg:min-w-[400px] lg:w-[400px]",
        },
      }),

      columnHelper.accessor(
        (row) => {
          if (row.from === polkadotAddress) {
            return "Sent";
          } else if (row.to === polkadotAddress) {
            return "Received";
          }
          return "-";
        },
        {
          id: "transactionType",
          header: "TRANSACTION TYPE",
          cell: (info) => (
            <span className="inline-block px-2 py-1 bg-grey-90 border border-grey-80 text-grey-40 rounded text-xs">
              {info.getValue()}
            </span>
          ),
        }
      ),
      columnHelper.accessor("date", {
        id: "date",
        header: "TRANSACTION DATE",
        cell: (d) => formatDate(new Date(d.getValue())),
        enableSorting: true,
      }),
    ],
    [polkadotAddress] // Add polkadotAddress as dependency
  );

  const columns = baseColumns;

  const table = useReactTable({
    columns,
    data: paginatedData,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
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

        {isPending && (
          <div className="w-full h-[350px] flex items-center justify-center p-6 animate-fade-in-0.3 opacity-0">
            <Loader2 className="size-6 animate-spin text-grey-50" />
          </div>
        )}

        {transactions && !transactions.length && (
          <div className="w-full h-[350px] flex items-center justify-center p-6">
            <div className="flex flex-col items-center opacity-0 animate-fade-in-0.5">
              <AbstractIconWrapper className="size-10 rounded-2xl bg-grey-40/20 mb-2">
                <Dollar className="absolute size-6" />
              </AbstractIconWrapper>
              <span className="text-grey-60 text-sm font-medium max-w-[190px] text-center">
                You have not received any transactions yet
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

export default TransactionHistoryTable;

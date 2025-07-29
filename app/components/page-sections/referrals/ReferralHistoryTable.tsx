import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { P } from "@/components/ui/typography";
import { AlertCircle, Hourglass, Loader2, Send } from "lucide-react";
import {
  TableWrapper,
  Table,
  Tr,
  Td,
  Th,
  THead,
  TBody
} from "@/components/ui/alt-table";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel
} from "@tanstack/react-table";
import {
  ReferralEvent,
  useUserReferrals
} from "@/app/lib/hooks/api/useUserReferrals";

const columnHelper = createColumnHelper<ReferralEvent>();

const ReferralHistoryTable: React.FC = () => {
  const { data, isPending, isError } = useUserReferrals();

  const columns = [
    columnHelper.accessor("address", {
      header: "ADDRESS",
      cell: (d) => `$ ${d.getValue().toLocaleString()}`,
      enableSorting: false
    }),
    columnHelper.accessor("reward", {
      header: "REWARD",
      enableSorting: true
    }),
    columnHelper.accessor("date", {
      header: "DATE",
      enableSorting: true
    }),
    columnHelper.accessor("status", {
      header: "STATUS",
      enableSorting: true
    })
  ];

  const table = useReactTable({
    columns,
    data: data?.referralHistory || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  return (
    <div>
      <div className="flex items-center gap-x-2 mb-4">
        <AbstractIconWrapper className="size-10">
          <Hourglass className="absolute size-6 text-primary-50" />
        </AbstractIconWrapper>
        <P size="lg">Referral History</P>
      </div>
      {/* <TransactionHistory /> */}

      <TableWrapper className="mt-5">
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
              return (
                <Tr key={row.id} transparent>
                  {row.getVisibleCells().map((cell) => (
                    <Td className="text-grey-20" key={cell.id} cell={cell} />
                  ))}
                </Tr>
              );
            })}
          </TBody>
        </Table>
        {isError && !data && (
          <div className="p-6 w-full h-[350px] flex items-center justify-center">
            <div className="flex flex-col animate-fade-in-0.5 items-center opacity-0">
              <AbstractIconWrapper className="size-10 rounded-2xl flex items-center justify-center bg-grey-40/20 mb-2">
                <AlertCircle className="absolute size-6 text-red-400" />
              </AbstractIconWrapper>
              <span className="text-grey-60 text-sm font-medium max-w-[190px] text-center">
                Failed to get data
              </span>
            </div>
          </div>
        )}
        {isPending && (
          <div className="w-full animate-fade-in-0.3 opacity-0 h-[350px] flex items-center justify-center p-6">
            <Loader2 className="size-6 animate-spin text-grey-50" />
          </div>
        )}
        {data && !data.referralHistory.length && (
          <div className="w-full h-[350px] flex items-center justify-center p-6">
            <div className="flex flex-col animate-fade-in-0.5 items-center opacity-0">
              <AbstractIconWrapper className="size-10 rounded-2xl flex items-center justify-center bg-grey-40/20 mb-2">
                <Send className="absolute size-6 text-primary-50" />
              </AbstractIconWrapper>
              <span className="text-grey-60 text-sm font-medium max-w-[190px] text-center">
                You have not made any referrals yet
              </span>
            </div>
          </div>
        )}
      </TableWrapper>
    </div>
  );
};

export default ReferralHistoryTable;

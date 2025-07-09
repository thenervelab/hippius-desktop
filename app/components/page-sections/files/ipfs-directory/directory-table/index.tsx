import { FC } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";

import * as TableModule from "@/components/ui/new-table";
import { decodeHexCid } from "@/lib/decode-hex-cid";
import { formatBytesFromBigInt } from "@/lib/utils/format-bytes";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Copy,
  Download,
  LinkIcon,
  MoreVertical
} from "lucide-react";
import { P } from "@/components/ui/typography";
import WaitAMoment from "@/components/ui/wait-a-moment";
import NoEntriesFound from "@/components/ui/no-entries-found";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

import usePagination from "@/hooks/usePagination";
import { DocumentFile } from "../../ui/icons";
import MinersCell from "@/components/ipfs/files-table/miners-cell";
import { HIPPIUS_EXPLORER_CONFIG } from "@/lib/config";

type FileRow = {
  filename: string;
  sizeBytes: number;
  cid: string;
  miners: string[];
};

interface DirectoryTableProps {
  data: FileRow[];
  isLoading: boolean;
  isRefetching: boolean;
  error: any;
}

const columnHelper = createColumnHelper<FileRow>();

const DirectoryTable: FC<DirectoryTableProps> = ({
  data,
  isLoading,
  isRefetching,
  error,
}) => {
  const { paginatedData, currentPage, totalPages, setCurrentPage } =
    usePagination(data, 10);

  const table = useReactTable({
    data: paginatedData,
    columns: [
      columnHelper.accessor("filename", {
        header: "CHUNK NAME",
        id: "filename",
        enableSorting: false,
        cell: (info) => (
          <div className="flex items-center">
            <DocumentFile className="size-5 text-primary-40 mr-2.5" />
            <span className="text-grey-20">{info.getValue()}</span>
        </div>
        ),
      }),
      columnHelper.accessor("sizeBytes", {
        header: "CHUNK SIZE",
        id: "size",
        enableSorting: true,
        cell: (info) =><span className="text-grey-20">{formatBytesFromBigInt(BigInt(info.getValue()))}</span>,
      }),
      columnHelper.accessor("cid", {
        header: "CID",
        id: "cid",
        enableSorting: true,
        cell: (info) => {
          const short = decodeHexCid(info.getValue());
          return (
            <TableModule.CopyableCell
              title="Copy CID"
              toastMessage="CID Copied Successfully!"
              copyAbleText={short}
              link={`${HIPPIUS_EXPLORER_CONFIG.baseUrl}/cid-tracker/${short}`}
              forSmallScreen={true}
            />
          );
        },
      }),
      columnHelper.display({
        header: "MINERS",
        id: "miners",
        enableSorting: false,
        cell: ({ row: { original } }) => (
          <MinersCell
            isAssigned={true}
            minerIds={original.miners}
          />
        ),
      }),
      columnHelper.display({
        id: "actions",
        cell: ({ row: { original } }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-gray-600 hover:bg-grey-70/10 rounded-[8px]"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="bg-white border border-gray-200"
            >
              <DropdownMenuItem
                className="text-gray-700 hover:opacity-60 cursor-pointer"
                onClick={() =>
                  window.open(
                    `https://get.hippius.network/ipfs/${decodeHexCid(original.cid)}`,
                    "_blank"
                  )
                }
              >
                <LinkIcon className="mr-2 h-4 w-4" />
                <span>View on IPFS</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-gray-700 hover:opacity-60 cursor-pointer"
                onClick={() => {
                  navigator.clipboard.writeText(`https://get.hippius.network/ipfs/${decodeHexCid(original.cid)}`).then(() => {
                    toast.success("IPFS Link Copied!");
                  });
                }}
              >
                <Copy className="mr-2 h-4 w-4" />
                <span>Copy Link</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-gray-700 hover:opacity-60 cursor-pointer"
                onClick={async () => {
                  try {
                    // build the IPFS download URL
                    const url = `https://get.hippius.network/ipfs/${decodeHexCid(original.cid)}`;
                    const res = await fetch(url);
                    if (!res.ok) throw new Error(res.statusText);
                    const filename = original.filename;

                    // turn response into a blob
                    const blob = await res.blob();
                    const downloadUrl = URL.createObjectURL(blob);

                    // create a temporary <a> to trigger the download
                    const a = document.createElement("a");
                    a.href = downloadUrl;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();

                    // free up memory
                    URL.revokeObjectURL(downloadUrl);
                    toast.success("File downloaded successfully");
                  } catch (err) {
                    console.error("Download failed:", err);
                    toast.error("Download failed");
                  }
                }}
              >
                <Download className="mr-2 h-4 w-4" />
                <span>Download</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="flex flex-col gap-y-4">

      <TableModule.TableWrapper className="mt-4">
        {error ? (
          <div className="p-6">
            <P className="text-error-70">Oops, something went wrong.</P>
          </div>
        ) : isLoading || isRefetching ? (
          <WaitAMoment />
        ) : data.length === 0 ? (
          <NoEntriesFound />
        ) : (
          <TableModule.Table>
            <TableModule.THead>
              {table.getHeaderGroups().map((hg) => (
                <TableModule.Tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <TableModule.Th key={h.id} header={h} />
                  ))}
                </TableModule.Tr>
              ))}
            </TableModule.THead>
            <TableModule.TBody>
              {table.getRowModel().rows.map((row) => (
                <TableModule.Tr key={row.id} rowHover>
                  {row.getVisibleCells().map((cell) => (
                    <TableModule.Td key={cell.id} cell={cell} />
                  ))}
                </TableModule.Tr>
              ))}
            </TableModule.TBody>
          </TableModule.Table>
        )}
      </TableModule.TableWrapper>

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

export default DirectoryTable;

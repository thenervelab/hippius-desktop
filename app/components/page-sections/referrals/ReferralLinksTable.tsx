"use client";

import React, { useState, useMemo } from "react";
import { Loader2 } from "lucide-react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable
} from "@tanstack/react-table";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { P } from "@/components/ui/typography";
import {
  TableWrapper,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  Pagination,
  CopyableCell
} from "@/components/ui/alt-table";

import { REFERRAL_CODE_CONFIG } from "@/lib/config";
import {
  ReferralLink,
  useReferralLinks
} from "@/app/lib/hooks/api/useReferralLinks";
import { Link } from "../../ui/icons";

const columnHelper = createColumnHelper<ReferralLink>();

export default function ReferralLinksTable() {
  const { links, loading } = useReferralLinks();

  // pagination setup
  const pageSize = 10;
  const [pageIndex, setPageIndex] = useState(0);
  const totalPages = Math.ceil(links.length / pageSize);
  const pageData = useMemo(
    () => links.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [links, pageIndex]
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor("code", {
        header: "Link",
        cell: ({ getValue }) => {
          const fullReferralCode = `${REFERRAL_CODE_CONFIG.link}${getValue()}`;
          return (
            <>
              <div className="hidden lg:block">{fullReferralCode}</div>
              <div className="lg:hidden max-w-[150px]">
                {fullReferralCode.slice(0, 5)}...
                {fullReferralCode.slice(fullReferralCode.length - 6)}
              </div>
            </>
          );
        }
      }),
      columnHelper.accessor("reward", {
        header: "Credits Earned",
        cell: (info) => `${info.getValue()} Credits`
      }),
      columnHelper.display({
        id: "copy",
        header: "",
        cell: ({ row }) => {
          const code = row.original.code;
          const url = `${REFERRAL_CODE_CONFIG.link}${code}`;
          return (
            <CopyableCell
              buttonClass="!text-grey-70"
              title="Copy Referral Code"
              toastMessage="Referral Code Copied Successfully!"
              copyAbleText={url}
              showCopyAbleText={false}
            />
          );
        }
      })
    ],
    []
  );

  const table = useReactTable({
    data: pageData,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  return (
    <div className="mb-6">
      <div className="flex items-center gap-x-2 mb-4">
        <AbstractIconWrapper className="size-10">
          <Link className="absolute size-6 text-primary-50" />
        </AbstractIconWrapper>
        <P size="lg">Your Referral Links</P>
      </div>

      <TableWrapper>
        {loading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="animate-spin text-gray-500 size-8" />
          </div>
        ) : table.getRowModel().rows.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No referral links yet
          </div>
        ) : (
          <>
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
                  <Tr key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <Td className="text-grey-20" key={cell.id} cell={cell} />
                    ))}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </>
        )}
      </TableWrapper>
      {totalPages > 1 && (
        <Pagination
          className="mt-5"
          currentPage={pageIndex + 1}
          totalPages={totalPages}
          setPage={(p) => setPageIndex(p - 1)}
        />
      )}
    </div>
  );
}

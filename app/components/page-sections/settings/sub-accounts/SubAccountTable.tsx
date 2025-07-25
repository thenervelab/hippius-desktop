"use client";

import React, { useState, useMemo } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable
} from "@tanstack/react-table";
import {
  TableWrapper,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  CopyableCell,
  Pagination
} from "@/components/ui/alt-table";
import { Loader2 } from "lucide-react";
import { SubAccount } from "@/app/lib/hooks/api/useSubAccounts";
import { Icons } from "@/app/components/ui";
import { ShieldSecurity } from "@/app/components/ui/icons";
import { saveSubAccountSeed } from "@/app/lib/helpers/subAccountSeedsDb";
import { getWalletRecord } from "@/app/lib/helpers/walletDb";
import { hashPasscode } from "@/app/lib/helpers/crypto";
import SeedPasscodeModal from "./SeedPasscodeModal";
import ViewSeedModal from "./ViewSeedModal";

type Props = {
  subs: SubAccount[];
  loading: boolean;
  onDelete: (addr: string) => void;
  hasSeed: (addr: string) => boolean;
  onSeedUpdated?: () => void;
};

const columnHelper = createColumnHelper<SubAccount>();
const ITEMS_PER_PAGE = 10;

const SubAccountTable: React.FC<Props> = ({
  subs,
  loading,
  onDelete,
  hasSeed,
  onSeedUpdated
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [isViewSeedModalOpen, setIsViewSeedModalOpen] = useState(false);
  const [isSetSeedModalOpen, setIsSetSeedModalOpen] = useState(false);
  const totalPages = useMemo(
    () => Math.ceil(subs.length / ITEMS_PER_PAGE),
    [subs.length]
  );

  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return subs.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [subs, currentPage]);

  const handleViewSeed = (addr: string) => {
    setSelectedAddress(addr);
    setIsViewSeedModalOpen(true);
  };

  const handleSetSeed = (addr: string) => {
    setSelectedAddress(addr);
    setIsSetSeedModalOpen(true);
  };

  const handleSetSeedSubmit = async ({
    seed,
    passcode
  }: {
    seed?: string;
    passcode: string;
  }) => {
    try {
      if (!seed) {
        return { success: false, error: "Seed phrase is required" };
      }

      const walletRecord = await getWalletRecord();
      if (!walletRecord) throw new Error("No wallet record found");

      if (hashPasscode(passcode) !== walletRecord.passcodeHash) {
        return { success: false, error: "Incorrect passcode" };
      }

      await saveSubAccountSeed(selectedAddress, seed, passcode);

      if (onSeedUpdated) {
        onSeedUpdated();
      }

      return { success: true };
    } catch (error) {
      console.error("Failed to save seed:", error);
      return { success: false, error: "Failed to save seed" };
    }
  };

  const columns = React.useMemo(
    () => [
      columnHelper.accessor("address", {
        header: "Address",
        cell: (cell) => {
          const value = cell.getValue();
          return (
            <CopyableCell
              title="Copy Address"
              toastMessage="Address Copied Successfully!"
              copyAbleText={value}
            />
          );
        }
      }),

      columnHelper.accessor("role", {
        header: "Role",
        cell: (info) => (
          <span className="inline-block px-2 py-1 bg-grey-90 border border-grey-80 text-grey-40 rounded text-xs">
            {info.getValue()}
          </span>
        )
      }),

      columnHelper.accessor("seed", {
        header: () => (
          <div className="w-full flex justify-center text-center">Seed</div>
        ),
        size: 40,
        maxSize: 40,
        cell: ({ row }) => {
          const address = row.original.address;
          const seedExists = hasSeed(address);

          return (
            <div className="flex justify-center">
              {seedExists ? (
                <button
                  onClick={() => handleViewSeed(address)}
                  title="View Seed"
                  className="text-grey-70 hover:text-primary-50 transition"
                >
                  <ShieldSecurity className="size-5 text-primary-40" />
                </button>
              ) : (
                <button
                  onClick={() => handleSetSeed(address)}
                  title="Set Seed"
                  className="text-grey-70 hover:text-primary-50 transition"
                >
                  <Icons.AddCircle className="size-5" />
                </button>
              )}
            </div>
          );
        }
      }),

      columnHelper.display({
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const s = row.original;
          return (
            <div className="flex justify-center items-center">
              <button
                onClick={() => onDelete(s.address)}
                title="Delete"
                className="text-grey-70 hover:text-red-600 transition"
              >
                <Icons.Trash className="size-5" />
              </button>
            </div>
          );
        }
      })
    ],
    [hasSeed]
  );

  const table = useReactTable({
    data: paginatedData,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  return (
    <>
      <TableWrapper className="mt-4 bg-white">
        {loading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="animate-spin text-gray-500 size-8" />
          </div>
        ) : table.getRowModel().rows.length === 0 ? (
          <div className="p-6 flex justify-center text-gray-500">
            {subs.length === 0
              ? "No sub accounts yet"
              : "No sub accounts on this page"}
          </div>
        ) : (
          <>
            <Table>
              <THead>
                {table.getHeaderGroups().map((hg) => (
                  <Tr key={hg.id}>
                    {hg.headers.map((header) => (
                      <Th key={header.id} header={header} />
                    ))}
                  </Tr>
                ))}
              </THead>
              <TBody>
                {table.getRowModel().rows.map((row) => (
                  <Tr key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <Td key={cell.id} cell={cell} />
                    ))}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </>
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

      <ViewSeedModal
        open={isViewSeedModalOpen}
        onClose={() => setIsViewSeedModalOpen(false)}
        address={selectedAddress}
      />

      {/* Set Seed Modal */}
      <SeedPasscodeModal
        open={isSetSeedModalOpen}
        onClose={() => setIsSetSeedModalOpen(false)}
        title="Set Sub Account Seed"
        description="Enter seed phrase for sub account"
        address={selectedAddress}
        seedInputRequired={true}
        onSubmit={handleSetSeedSubmit}
        cancelLabel="Cancel"
        submitLabel="Set Seed"
      />
    </>
  );
};

export default SubAccountTable;

"use client";

import type { ComponentProps, FC } from "react";

import NoEntriesFound from "@/components/ui/NoEntriesFound";
import {
  SkeletonTableRow,
  Table,
  TableWrapper,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "@/components/ui/table";
import StatusTypeBadge from "@/components/page-sections/billing/StatusTypeBadge";
import TransactionTypeBadge from "@/components/page-sections/billing/TransactionTypeBadge";
import useDriveSubscriptionHistory from "@/lib/hooks/api/useDriveSubscriptionHistory";
import { cn } from "@/lib/utils";

type StatusKind = NonNullable<ComponentProps<typeof StatusTypeBadge>["type"]>;
const STATUS_KINDS: ReadonlySet<string> = new Set([
  "failed",
  "pending",
  "success",
  "successful",
  "completed",
]);

/** The badge only knows a fixed set of states; anything else draws no pill. */
function toStatusKind(status: string): StatusKind | null {
  const key = status.toLowerCase();
  return STATUS_KINDS.has(key) ? (key as StatusKind) : null;
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Every charge and change on the drive plan, under the plans themselves.
 * The same table shape and pills Billing draws, so the two ledgers read as
 * one system.
 */
const DriveSubscriptionHistory: FC<{ className?: string }> = ({
  className,
}) => {
  const { data, isLoading } = useDriveSubscriptionHistory();
  const rows = data ?? [];

  return (
    <section
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-[8px] border border-grey-dark-100 bg-grey-light-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)] dark:border-black-300 dark:bg-black-primary-bg",
        className,
      )}
    >
      <div className="flex h-[46px] w-full items-center px-[14px]">
        <h2 className="text-[18px] font-medium leading-8 text-black-700 dark:text-white">
          Subscription History
        </h2>
      </div>
      <div className="w-full rounded-[8px] border border-grey-dark-100 bg-white dark:border-black-300 dark:bg-black-600">
        {isLoading ? (
          <TableWrapper>
            <Table>
              <TBody>
                <SkeletonTableRow rows={4} columns={5} />
              </TBody>
            </Table>
          </TableWrapper>
        ) : rows.length === 0 ? (
          <div className="py-8">
            <NoEntriesFound
              title="No plan charges yet"
              description="Charges, renewals and plan changes appear here."
            />
          </div>
        ) : (
          <TableWrapper>
            <Table>
              <THead>
                <Tr>
                  <Th>Plan</Th>
                  <Th className="w-32">Amount</Th>
                  <Th className="w-44">Transaction Type</Th>
                  <Th className="w-40">Status</Th>
                  <Th className="w-52">Date</Th>
                </Tr>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <Tr key={row.id}>
                    <Td className="text-[12px] font-medium text-grey-dark-800">
                      {row.description}
                    </Td>
                    <Td className="text-[12px] font-medium text-grey-dark-800">
                      ${row.amount}
                    </Td>
                    <Td>
                      <TransactionTypeBadge
                        type={
                          row.transaction_type === "card" ? "card" : "credits"
                        }
                      />
                    </Td>
                    <Td>
                      <StatusTypeBadge type={toStatusKind(row.status)} />
                    </Td>
                    <Td className="text-[12px] font-medium text-grey-dark-800">
                      {formatDate(row.transaction_date)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableWrapper>
        )}
      </div>
    </section>
  );
};

export default DriveSubscriptionHistory;

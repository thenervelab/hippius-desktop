"use client";

import React from "react";
import { TableWrapper } from "@/components/ui/table";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { GitCompareArrows } from "@/components/ui/icons";

/* Bridge Transactions tab — placeholder.
 *
 * Bridge functionality is deferred behind the rest of the wallet
 * redesign because the Rust IPCs that would feed this table
 * (bridge submit + bridge history) don't exist yet. The tab is shown
 * today so the wallet page reads as its final shape; once the Rust
 * backend lands, this file gets the same fetcher/table treatment as
 * TransactionHistoryTable. */
const BridgeTransactionHistoryTable: React.FC = () => {
  return (
    <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
      <div className="flex h-[21.875rem] w-full items-center justify-center p-6">
        <div className="flex flex-col items-center opacity-0 animate-fade-in-0.5">
          <AbstractIconWrapper className="size-10 rounded-2xl bg-grey-40/20 mb-2">
            <GitCompareArrows className="absolute size-5 text-grey-50" />
          </AbstractIconWrapper>
          <span className="text-grey-60 dark:text-grey-dark-600 text-sm font-medium max-w-[18.75rem] text-center">
            Bridge transactions will appear here once bridging is enabled.
          </span>
        </div>
      </div>
    </TableWrapper>
  );
};

export default BridgeTransactionHistoryTable;

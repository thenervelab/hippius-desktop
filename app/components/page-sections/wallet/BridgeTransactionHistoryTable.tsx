"use client";

import React from "react";
import NoEntriesFound from "@/components/ui/NoEntriesFound";

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
    <div className="p-3">
      <NoEntriesFound
        title="No bridge transactions yet"
        description="Bridge transactions will appear here once bridging is enabled. The Bridge Tokens action above is the entry point when it ships."
        cardView={false}
        className="p-6 sm:p-10 rounded-[8px]"
      />
    </div>
  );
};

export default BridgeTransactionHistoryTable;

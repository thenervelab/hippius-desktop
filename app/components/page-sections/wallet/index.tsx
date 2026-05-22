"use client";

import React, { useState, useEffect } from "react";
import { Plus } from "lucide-react";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import PageHeader from "@/components/page-sections/home/PageHeader";
import { Button } from "@/components/ui";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

import WalletBalanceCard from "./WalletBalanceCard";
import WalletStakeCard from "./WalletStakeCard";
import WalletBridgeCard from "./WalletBridgeCard";
import TransactionOverviewGraph from "./TransactionOverviewGraph";
import ActiveWalletSelector from "./ActiveWalletSelector";
import WalletWithLocalSupport from "./WalletWithLocalSupport";

import TransactionHistoryTable from "./TransactionHistoryTable";
import BridgeTransactionHistoryTable from "./BridgeTransactionHistoryTable";
import AddressBookTable from "./AddressBookTable";
import AddNewAddressDialog from "./AddNewAddressDialog";

import useBalanceTransactions from "@/app/lib/hooks/api/useBalanceTransactions";
import useSystemBalance from "@/app/lib/hooks/api/useSystemBalance";
import { getContacts } from "@/app/lib/helpers/addressBookDb";

const TAB_OPTIONS = [
  { value: "Transaction History" as const, label: "Transaction History" },
  { value: "Bridge Transactions" as const, label: "Bridge Transactions" },
  { value: "Address Book" as const, label: "Address Book" },
];
type WalletTab = (typeof TAB_OPTIONS)[number]["value"];

export default function Wallet() {
  const { data: transactions, isPending, refetch } = useBalanceTransactions();
  const { refetch: refetchSystemBalance } = useSystemBalance();

  const [activeTab, setActiveTab] = useState<WalletTab>("Transaction History");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [contacts, setContacts] = useState<
    Array<{
      id: number;
      name: string;
      walletAddress: string;
      dateAdded: number;
    }>
  >([]);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    if (activeTab !== "Address Book") return;
    const loadContacts = async () => {
      const contactList = await getContacts();
      setContacts(contactList);
    };
    loadContacts();
  }, [activeTab, refreshTrigger]);

  const handleContactChanged = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  return (
    <>
      <DashboardTitleWrapper mainText="Wallet">
        {/* PageHeader sits OUTSIDE the WalletWithLocalSupport gate so the
            title + subtitle + ACTIVE WALLET selector are visible on every
            wallet screen — including the no-wallet-yet welcome flow. Only
            the body content (the 3-card grid + chart + tabs) is gated.
            `flex-1` lets the welcome screen's inner flex-1 expand to fill
            the remaining vertical space below the header — without it
            the diagonal-stripe area would collapse to the card's natural
            height. */}
        <div className="flex flex-1 min-h-0 flex-col px-4 pb-6">
          <PageHeader
            title="Wallet"
            subtitle="All uploaded files are private and securely encrypted."
            showTopUpCredits={false}
            rightSlot={<ActiveWalletSelector />}
          />

          <WalletWithLocalSupport>
          {/* Top 3-column grid: Balance, Stake, Bridge */}
          <div className="mt-4 grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 gap-4">
            <WalletBalanceCard
              refetchTransactions={refetch}
              refetchSystemBalance={refetchSystemBalance}
            />
            <WalletStakeCard />
            <WalletBridgeCard />
          </div>

          {/* Transaction overview chart panel */}
          <div className="mt-6">
            <TransactionOverviewGraph />
          </div>

          {/* Tabbed table surface */}
          <div className="mt-6 flex flex-col items-center w-full rounded-[8px] border overflow-hidden bg-grey-light-300 border-grey-dark-100 dark:bg-black-primary-bg dark:border-black-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]">
            <div className="flex flex-col @md:flex-row gap-2 @md:gap-3 w-full items-stretch @md:items-center justify-between px-[14px] py-2">
              <SegmentedControl
                ariaLabel="Wallet data tabs"
                options={TAB_OPTIONS}
                value={activeTab}
                onChange={(value) => setActiveTab(value)}
                showActiveIndicator={false}
              />
              {activeTab === "Address Book" && (
                <Button
                  variant="primary"
                  size="auto"
                  className="h-8 rounded-[6px] px-3 text-[13px] font-medium tracking-[-0.26px] gap-2"
                  onClick={() => setShowAddDialog(true)}
                >
                  <Plus className="size-3.5" />
                  New Address
                </Button>
              )}
            </div>
            <div className="flex flex-col w-full flex-1 rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300 overflow-hidden">
              {activeTab === "Transaction History" && (
                <TransactionHistoryTable
                  transactions={transactions}
                  isPending={isPending}
                />
              )}
              {activeTab === "Bridge Transactions" && (
                <BridgeTransactionHistoryTable />
              )}
              {activeTab === "Address Book" && (
                <AddressBookTable
                  contacts={contacts}
                  onContactChanged={handleContactChanged}
                  onAddAddress={() => setShowAddDialog(true)}
                />
              )}
            </div>
          </div>
          </WalletWithLocalSupport>
        </div>
      </DashboardTitleWrapper>

      <AddNewAddressDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onAddSuccess={handleContactChanged}
      />
    </>
  );
}

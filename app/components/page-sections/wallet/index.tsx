"use client";

import React, { useEffect, useRef, useState } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info, Plus } from "lucide-react";

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
  const {
    data: transactions,
    isPending,
    isPlaceholderData: isTransactionsPlaceholder,
    refetch,
  } = useBalanceTransactions();
  // `isPending` is false on subsequent renders that show the previous
  // wallet's data via `keepPreviousData`. `isPlaceholderData` flips
  // true during a wallet switch until the new wallet's transactions
  // arrive — combine the two so the skeleton fires for both
  // "first load" and "wallet just switched".
  const transactionsLoading = isPending || isTransactionsPlaceholder;
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

  /* Portal target for the bridge tab's filter + mini-pagination
   * controls. We render an empty div in the tab bar header and let
   * BridgeTransactionHistoryTable inject the controls into it via
   * createPortal — same pattern hippius-web uses. */
  const bridgeHeaderRef = useRef<HTMLDivElement | null>(null);
  const [bridgeHeaderEl, setBridgeHeaderEl] = useState<HTMLDivElement | null>(
    null,
  );
  // Sync the ref-callback into state so the table re-portals when the
  // div mounts/unmounts as the tab changes.
  useEffect(() => {
    setBridgeHeaderEl(bridgeHeaderRef.current);
  }, [activeTab]);

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
            infoButton={
              <TooltipPrimitive.Provider delayDuration={300}>
                <TooltipPrimitive.Root>
                  <TooltipPrimitive.Trigger asChild>
                    <button
                      type="button"
                      aria-label="Wallet information"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </TooltipPrimitive.Trigger>
                  <TooltipPrimitive.Portal>
                    <TooltipPrimitive.Content
                      side="bottom"
                      align="center"
                      sideOffset={8}
                      avoidCollisions
                      collisionPadding={8}
                      className="z-[9999] max-w-[280px] rounded-[8px] border border-grey-dark-100 bg-white px-3 py-[10px] text-[12px] font-medium leading-4 tracking-[-0.24px] text-[#52525c] shadow-[0px_4px_24px_0px_rgba(0,0,0,0.08)] dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-[#a3a3a3] dark:shadow-black/25"
                    >
                      Send and receive hAlpha, stake or unstake your tokens,
                      bridge between alpha and TAO, and manage saved
                      recipient addresses — all from this page.
                      <TooltipPrimitive.Arrow className="fill-white dark:fill-[#2c2c2c]" />
                    </TooltipPrimitive.Content>
                  </TooltipPrimitive.Portal>
                </TooltipPrimitive.Root>
              </TooltipPrimitive.Provider>
            }
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
              {activeTab === "Bridge Transactions" && (
                <div ref={bridgeHeaderRef} />
              )}
            </div>
            <div className="flex flex-col w-full flex-1 rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300 overflow-hidden">
              {activeTab === "Transaction History" && (
                <TransactionHistoryTable
                  transactions={transactions}
                  isPending={transactionsLoading}
                />
              )}
              {activeTab === "Bridge Transactions" && (
                <BridgeTransactionHistoryTable
                  headerPortalTarget={bridgeHeaderEl}
                />
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

"use client";

import React, { useState, useEffect, useMemo } from "react";

import WalletBalanceWidget from "./WalletBalanceWidget";
import StakeWidget from "./StakeWidget";
import BridgeWidget from "./BridgeWidget";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import TransactionHistoryTable from "./TransactionHistoryTable";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import { CardButton, Icons } from "@/components/ui";
import { PlusCircle } from "lucide-react";
import AddNewAddressDialog from "./AddNewAddressDialog";
import { getContacts } from "@/app/lib/helpers/addressBookDb";
import AddressBookTable from "./AddressBookTable";
import useBalanceTransactions from "@/app/lib/hooks/api/useBalanceTransactions";
import useSystemBalance from "@/app/lib/hooks/api/useSystemBalance";
import BalanceTrends from "./balance-trends";

export default function Wallet() {
  const { data: transactions, isPending, refetch } = useBalanceTransactions();
  const {
    data: balanceDaily,
    isLoading: isBalanceLoading,
    refetch: refetchSystemBalance,
  } = useSystemBalance();
  const [activeTab, setActiveTab] = useState("Transaction History");
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

  const chartData = useMemo(() => {
    const rows = balanceDaily ?? [];
    return rows.map((r) => {
      return {
        processed_timestamp: r.timestamp,
        credit: "0",
        total_balance: r.totalBalance,
      };
    });
  }, [balanceDaily]);

  const isChartDataLoading = isBalanceLoading;

  useEffect(() => {
    if (activeTab === "Address Book") {
      loadContacts();
    }
  }, [activeTab, refreshTrigger]);

  const loadContacts = async () => {
    const contactList = await getContacts();
    setContacts(contactList);
  };

  const handleContactChanged = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  const tabs: TabOption[] = [
    {
      tabName: "Transaction History",
      icon: <Icons.BoxTime className="size-4" />,
    },
    {
      tabName: "Address Book",
      icon: <Icons.DocumentText className="size-4" />,
    },
  ];

  return (
    <>
      <DashboardTitleWrapper mainText="Wallet">
        <div className="w-full mt-6 grid grid-cols-3 gap-4">
          <WalletBalanceWidget
            refetchTransactions={refetch}
            refetchSystemBalance={refetchSystemBalance}
          />
          <StakeWidget />
          <BridgeWidget />
        </div>

        <div className="col-span-3 mt-4">
          <BalanceTrends
            className="min-w-0"
            chartData={chartData}
            isLoading={isChartDataLoading}
          />
        </div>

        <div className="mt-6">
          <div className="flex justify-between">
            <TabList
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              className="mb-6"
            />
            {activeTab === "Address Book" && (
              <CardButton
                className={"h-[40px] w-fit p-1"}
                onClick={() => setShowAddDialog(true)}
              >
                <div className="flex items-center gap-2 text-grey-100 text-base font-medium p-2">
                  <div>
                    <PlusCircle className="size-4" />
                  </div>
                  <span className="flex items-center">New Address</span>
                </div>
              </CardButton>
            )}
          </div>

          <div className="flex flex-col animate-in fade-in duration-300 gap-8 w-full shadow-menu rounded-lg bg-white p-4 border border-grey-80">
            {activeTab === "Transaction History" && (
              <TransactionHistoryTable
                transactions={transactions}
                isPending={isPending}
              />
            )}
            {activeTab === "Address Book" && (
              <AddressBookTable
                contacts={contacts}
                onContactChanged={handleContactChanged}
              />
            )}
          </div>
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

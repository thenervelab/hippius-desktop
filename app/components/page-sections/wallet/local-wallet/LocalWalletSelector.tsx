"use client";

import React, { useState, useRef, useEffect } from "react";
import { useLocalWallet, LocalWallet } from "@/app/contexts/LocalWalletContext";
import {
  ChevronUp,
  ChevronDown,
  ExternalLink,
  Plus,
  Settings,
} from "lucide-react";
import { Wallet } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

interface LocalWalletSelectorProps {
  className?: string;
  onAddWallet?: () => void;
  onOpenSettings?: () => void;
}

export function LocalWalletSelector({
  className,
  onAddWallet,
  onOpenSettings,
}: LocalWalletSelectorProps) {
  const { wallets, activeWallet, switchWallet, truncateAddress, isLoading } =
    useLocalWallet();

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleWalletSelect = async (walletId: number) => {
    await switchWallet(walletId);
    setIsOpen(false);
  };

  const openInExplorer = (address: string, e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(`https://hipstats.com/accounts/${address}`, "_blank");
  };

  const truncateName = (name: string) => {
    if (name.length <= 10) return name;
    return `${name.slice(0, 4)}...${name.slice(-3)}`;
  };

  // Loading state
  if (isLoading) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <div className="animate-spin h-4 w-4 border-2 border-primary-50 border-t-transparent rounded-full" />
        <span className="text-sm text-grey-50">Loading wallets...</span>
      </div>
    );
  }

  // No wallets - shouldn't happen if we're in "ready" state
  if (!activeWallet) {
    return null;
  }

  return (
    <div className={cn("relative", className)} ref={dropdownRef}>
      {/* Active Wallet Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <Wallet className="size-4 text-grey-50" />
          <span className="font-geist text-base font-medium text-grey-60">
            Active Wallet
          </span>
        </div>
        <div className="flex items-center gap-2 pl-2 border border-grey-80 rounded p-1.5">
          <div className="w-2 h-2 rounded-full bg-success-50" />
          <span className="font-geist text-base font-medium text-grey-10">
            {truncateAddress(activeWallet.address, 6, 4)}
          </span>
          {isOpen ? (
            <ChevronUp className="size-5 text-grey-50" />
          ) : (
            <ChevronDown className="size-5 text-grey-50" />
          )}
        </div>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-2 top-full mt-0.5 w-[400px] bg-white rounded-lg border border-grey-80 shadow-lg z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-4">
            <span className="font-geist text-lg font-medium text-grey-10">
              Your Wallets
            </span>
            {onOpenSettings && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOpen(false);
                  onOpenSettings();
                }}
                className="p-1 text-grey-50 hover:text-grey-30 transition-colors"
                title="Wallet Settings"
              >
                <Settings className="size-5" />
              </button>
            )}
          </div>

          {/* Wallets List */}
          <div className="px-4 pb-4 space-y-3 max-h-[400px] overflow-y-auto">
            {wallets.map((wallet: LocalWallet) => {
              const isActive = activeWallet.id === wallet.id;
              return (
                <div
                  key={wallet.id}
                  className="flex items-center justify-between px-2 py-1.5 border border-grey-80 rounded-lg hover:border-grey-70 transition-colors cursor-pointer bg-white"
                  onClick={() => handleWalletSelect(wallet.id)}
                >
                  <div className="flex items-center gap-1 flex-1 min-w-0">
                    <span className="font-geist text-base font-medium text-grey-20">
                      {truncateName(wallet.name)}
                    </span>
                    <span className="text-grey-20 text-base">|</span>
                    <span className="text-sm text-grey-60">
                      {truncateAddress(wallet.address, 6, 4)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-6">
                    {isActive ? (
                      <div className="px-2 py-1 text-xs font-medium text-primary-50 border border-primary-80 bg-primary-90 hover:bg-primary-80 rounded">
                        Active Wallet
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleWalletSelect(wallet.id);
                        }}
                        className="px-2 py-1 text-xs font-medium text-grey-50 border border-grey-80 bg-grey-90 hover:bg-grey-80 rounded"
                      >
                        Switch Wallet
                      </button>
                    )}
                    <button
                      onClick={(e) => openInExplorer(wallet.address, e)}
                      className="p-1 bg-grey-100 border border-grey-80 rounded transition-colors hover:bg-grey-90"
                      title="View in Explorer"
                    >
                      <ExternalLink className="size-4 text-grey-10" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add Wallet Button */}
          {onAddWallet && (
            <div className="px-4 pb-4">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOpen(false);
                  onAddWallet();
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-50 text-white rounded-lg hover:bg-primary-40 transition-colors font-medium text-sm"
              >
                <Plus className="size-4" />
                Add Wallet
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default LocalWalletSelector;

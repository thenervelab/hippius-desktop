"use client";

import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

import { useLocalWallet } from "@/app/contexts/LocalWalletContext";

interface ActiveWalletSelectorProps {
  className?: string;
}

const ActiveWalletSelector: React.FC<ActiveWalletSelectorProps> = ({
  className,
}) => {
  const { wallets, activeWallet, switchWallet, truncateAddress, setSetupStep } =
    useLocalWallet();

  const [isOpen, setIsOpen] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [isOpen]);

  const handleSwitch = async (walletId: number) => {
    if (activeWallet?.id === walletId) {
      setIsOpen(false);
      return;
    }
    const ok = await switchWallet(walletId);
    if (ok) {
      setIsOpen(false);
      toast.success("Switched wallet");
    } else {
      toast.error("Failed to switch wallet");
    }
  };

  const handleCopy = async (address: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopiedAddress(address);
      toast.success("Address copied");
      setTimeout(() => setCopiedAddress(null), 2000);
    } catch {
      toast.error("Failed to copy address");
    }
  };

  const handleAdd = () => {
    setIsOpen(false);
    setSetupStep("welcome");
  };

  // Reached only while the wallets list is loading — the gate
  // component renders the onboarding flow when truly no wallet exists.
  if (!activeWallet) {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-3 rounded-[8px] border border-grey-dark-100 dark:border-black-300 bg-grey-light-700 dark:bg-black-primary-bg px-3 py-2",
          className,
        )}
      >
        <div className="h-3 w-24 rounded bg-grey-light-800 dark:bg-grey-dark-200 animate-pulse" />
      </div>
    );
  }

  return (
    <div ref={dropdownRef} className={cn("relative inline-block", className)}>
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        className={cn(
          "inline-flex items-stretch gap-2 rounded-[8px] border bg-grey-light-700 dark:bg-black-primary-bg px-3 py-1.5",
          "border-grey-dark-100 dark:border-black-300",
          "transition-colors hover:bg-grey-light-800 dark:hover:bg-black-300/70",
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="flex flex-col items-start justify-center gap-[3px] pr-1">
          <div className="flex items-center gap-1">
            <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-primary-40/20">
              <span className="size-[6.15px] rounded-full bg-primary-40" />
            </span>
            <span className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
              Active Wallet
            </span>
          </div>
          <span className="text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-black-700 dark:text-grey-light-100">
            {activeWallet.name}
          </span>
        </div>

        <div className="flex items-center gap-2 border-l border-grey-dark-100 dark:border-black-500 pl-3 ml-1">
          <span className="font-mono text-[12px] font-medium uppercase text-black-700 dark:text-grey-light-100">
            {truncateAddress(activeWallet.address, 4, 4).toUpperCase()}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 text-grey-50 dark:text-grey-dark-600 transition-transform",
              isOpen && "rotate-180",
            )}
          />
        </div>
      </button>

      {isOpen && (
        <div
          className={cn(
            "absolute right-0 top-full mt-1 z-50 min-w-[280px] rounded-[8px] border shadow-lg",
            "border-grey-dark-100 bg-white dark:border-black-300 dark:bg-black-primary-bg",
          )}
          role="listbox"
        >
          <div className="py-1 max-h-[280px] overflow-y-auto custom-scrollbar-thin">
            {wallets.map((wallet) => {
              const isActive = activeWallet.id === wallet.id;
              const isCopied = copiedAddress === wallet.address;
              return (
                <button
                  key={wallet.id}
                  type="button"
                  onClick={() => handleSwitch(wallet.id)}
                  className={cn(
                    "w-full flex items-center justify-between gap-3 px-3 py-2",
                    "transition-colors hover:bg-grey-light-700 dark:hover:bg-black-300",
                    isActive && "bg-primary-40/[0.06] dark:bg-primary-brand-dark/[0.08]",
                  )}
                  role="option"
                  aria-selected={isActive}
                >
                  <div className="flex flex-col items-start min-w-0">
                    <div className="flex items-center gap-1.5">
                      {isActive ? (
                        <span className="size-1.5 rounded-full bg-primary-40 dark:bg-primary-brand-dark" />
                      ) : (
                        <span className="size-1.5 rounded-full bg-grey-80 dark:bg-grey-dark-700" />
                      )}
                      <span className="text-[13px] font-medium text-grey-10 dark:text-grey-light-100 truncate">
                        {wallet.name}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-grey-50 dark:text-grey-dark-600 mt-0.5 truncate">
                      {truncateAddress(wallet.address, 6, 5)}
                    </span>
                  </div>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Copy address"
                    className="shrink-0 flex items-center justify-center size-7 rounded-[6px] hover:bg-grey-light-800 dark:hover:bg-black-500 text-grey-50 dark:text-grey-dark-600"
                    onClick={(e) => handleCopy(wallet.address, e)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleCopy(wallet.address, e as unknown as React.MouseEvent);
                      }
                    }}
                  >
                    {isCopied ? (
                      <Check className="size-3.5 text-success-30" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="border-t border-grey-dark-100 dark:border-black-300">
            <button
              type="button"
              onClick={handleAdd}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-[13px] font-medium text-primary-50 dark:text-primary-brand-dark hover:bg-grey-light-700 dark:hover:bg-black-300"
            >
              <Plus className="size-3.5" />
              Add another wallet
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ActiveWalletSelector;

"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Plus,
  Settings,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { open as openShell } from "@tauri-apps/plugin-shell";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { HardDriveUpload } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDiagonalTextureBackgroundImage } from "@/lib/ui-textures";

interface ActiveWalletSelectorProps {
  className?: string;
}

/* ── 4-corner dot decoration — positioned OUTSIDE the border boundary ── */
function CornerDots({
  variant = "grey",
  show = false,
}: {
  variant?: "grey" | "blue";
  show?: boolean;
}) {
  const color =
    variant === "blue"
      ? "border-[#3167dd] bg-[#3167dd]/10 dark:border-primary-brand-dark dark:bg-primary-brand-dark/10"
      : "border-[#c9c9c9] bg-white dark:border-[#555] dark:bg-black-600";
  const visibility = show ? "opacity-100" : "opacity-0 group-hover/row:opacity-100";
  const dot =
    "pointer-events-none absolute size-[4px] rounded-[1px] border transition-opacity";
  return (
    <>
      <span className={cn(dot, "-left-[5px] -top-[5px]", color, visibility)} />
      <span className={cn(dot, "-right-[5px] -top-[5px]", color, visibility)} />
      <span className={cn(dot, "-bottom-[5px] -left-[5px]", color, visibility)} />
      <span className={cn(dot, "-bottom-[5px] -right-[5px]", color, visibility)} />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Wallet Row  (inside dropdown) — mirrors hippius-web WalletRow
   ─ active:  blue border + blue bg + corner dots always visible
   ─ default: grey border, corner dots appear on hover, plus a
              diagonal-stripe texture wash
   ═══════════════════════════════════════════════════════════════ */
function WalletRow({
  name,
  address,
  fullAddress,
  isActive,
  onSelect,
  onExplorer,
  onExport,
}: {
  name: string;
  address: string;
  fullAddress: string;
  isActive: boolean;
  onSelect: () => void;
  onExplorer: (e: React.MouseEvent) => void;
  onExport: (e: React.MouseEvent) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyAddress = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(fullAddress);
      setCopied(true);
      toast.success("Address copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy address");
    }
  };

  return (
    <div
      onClick={isActive ? undefined : onSelect}
      className={cn(
        "group/row relative flex cursor-pointer items-center justify-between overflow-visible border p-3 transition-all",
        isActive
          ? "rounded-[6px] border-[#3167dd] bg-[#3167dd]/[0.12] dark:border-primary-brand-dark dark:bg-primary-brand-dark/[0.12]"
          : "rounded-[6px] border-[#e3e3e3] bg-white hover:rounded-[62px] hover:bg-[#f8f8f8] dark:border-black-300 dark:bg-black-600 dark:hover:border-black-200 dark:hover:bg-black-500",
      )}
    >
      {/* Diagonal lines texture on hover */}
      {!isActive && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-[1] rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover/row:opacity-100"
          style={{
            backgroundImage: getDiagonalTextureBackgroundImage({
              color: "rgba(0,0,0,0.03)",
              gap: 6,
              lineWidth: 1,
            }),
          }}
        />
      )}

      {/* Wallet info */}
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-[13px] font-medium leading-[20px] tracking-[-0.26px]",
            isActive
              ? "text-[#3167dd] dark:text-primary-brand-dark"
              : "text-[#0a0a0a] dark:text-grey-light-100",
          )}
        >
          {name || "Unnamed"}
        </span>
        <div className="flex w-fit items-center gap-1.5">
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "cursor-default text-[11px] leading-normal tracking-[-0.2px]",
                    isActive
                      ? "text-[#3167dd]/70 dark:text-primary-brand-dark/70"
                      : "text-[#7d7d7d] dark:text-[#9a9a9a]",
                  )}
                >
                  {address}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="start"
                sideOffset={6}
                className="rounded-lg border border-[#e3e3e3] bg-white px-3 py-2 font-mono text-[11px] text-[#4f4f4f] shadow-md dark:border-black-300 dark:bg-black-600 dark:text-grey-light-100"
              >
                {fullAddress}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <button
            onClick={handleCopyAddress}
            className={cn(
              "shrink-0 rounded p-0.5 transition-colors",
              isActive
                ? "text-[#3167dd]/50 hover:text-[#3167dd] dark:text-primary-brand-dark/50 dark:hover:text-primary-brand-dark"
                : "text-[#b0b0b0] hover:bg-[#f0f0f0] hover:text-[#4f4f4f] dark:text-[#6a6a6a] dark:hover:bg-black-400 dark:hover:text-grey-light-100",
            )}
            aria-label="Copy address"
          >
            {copied ? (
              <Check className="size-3 text-[#22c55e]" />
            ) : (
              <Copy className="size-3" />
            )}
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="ml-3 flex shrink-0 items-center gap-2.5">
        {isActive ? (
          <span className="flex h-[21px] items-center rounded-[4px] border border-[#3167dd] bg-[#3167dd]/20 px-2 text-[10px] font-medium text-[#3167dd] dark:border-primary-brand-dark dark:bg-primary-brand-dark/20 dark:text-primary-brand-dark">
            Active wallet
          </span>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            className="flex h-[21px] items-center rounded-[4px] border border-[#cecece] bg-[#eaeaea] px-2 text-[10px] font-medium text-[#0a0a0a]/60 opacity-90 transition-colors hover:bg-[#e0e0e0] dark:border-black-300 dark:bg-black-400 dark:text-white/60 dark:hover:bg-black-300"
          >
            Switch wallet
          </button>
        )}
        <button
          onClick={onExport}
          className={cn(
            "flex size-[21px] items-center justify-center rounded-[4px] border transition-colors",
            isActive
              ? "border-[#3167dd] bg-[#3167dd]/[0.14] text-[#3167dd] opacity-70 hover:opacity-100 dark:border-primary-brand-dark dark:bg-primary-brand-dark/[0.14] dark:text-primary-brand-dark"
              : "border-[#cecece] bg-[#eaeaea] text-[#0a0a0a]/60 opacity-90 hover:bg-[#e0e0e0] dark:border-black-300 dark:bg-black-400 dark:text-white/60 dark:hover:bg-black-300",
          )}
          aria-label="Export backup"
          title="Export wallet backup"
        >
          <Download className="size-[11px]" />
        </button>
        <button
          onClick={onExplorer}
          className={cn(
            "flex size-[21px] items-center justify-center rounded-[4px] border transition-colors",
            isActive
              ? "border-[#3167dd] bg-[#3167dd]/[0.14] text-[#3167dd] opacity-70 hover:opacity-100 dark:border-primary-brand-dark dark:bg-primary-brand-dark/[0.14] dark:text-primary-brand-dark"
              : "border-[#cecece] bg-[#eaeaea] text-[#0a0a0a]/60 opacity-90 hover:bg-[#e0e0e0] dark:border-black-300 dark:bg-black-400 dark:text-white/60 dark:hover:bg-black-300",
          )}
          aria-label="Open in explorer"
          title="View on hipstats explorer"
        >
          <ExternalLink className="size-[11px]" />
        </button>
      </div>

      <CornerDots variant={isActive ? "blue" : "grey"} show={isActive} />
    </div>
  );
}

const ActiveWalletSelector: React.FC<ActiveWalletSelectorProps> = ({
  className,
}) => {
  const {
    wallets,
    activeWallet,
    switchWallet,
    truncateAddress,
    setSetupStep,
    isLoading,
    exportBackup,
  } = useLocalWallet();

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const goToWalletSettings = () => {
    setIsOpen(false);
    router.push("/settings?section=wallets");
  };

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

  const handleCreate = () => {
    setIsOpen(false);
    setSetupStep("create-mnemonic");
  };

  const handleImport = () => {
    setIsOpen(false);
    setSetupStep("import-wallet");
  };

  const handleExport = async (walletId: number, walletName: string) => {
    try {
      const backup = await exportBackup(walletId);
      if (!backup) {
        toast.error("Failed to export wallet");
        return;
      }
      const safeName = walletName.trim().replace(/\s+/g, "-") || "wallet";
      const filePath = await save({
        filters: [{ name: "Wallet backup", extensions: ["json"] }],
        defaultPath: `hippius-wallet-${safeName}-backup.json`,
      });
      if (!filePath) return;
      const payload = {
        version: 2,
        ...backup,
      };
      await writeTextFile(filePath, JSON.stringify(payload, null, 2));
      toast.success("Wallet backup saved");
    } catch (e) {
      console.error("[ActiveWalletSelector] export failed:", e);
      toast.error("Failed to export wallet");
    }
  };

  if (isLoading) {
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

  // No-wallet variant: same chrome as the wallet-present trigger so
  // the header doesn't visually jump when a user creates their first
  // wallet, just different content and a different dropdown payload.
  if (!activeWallet) {
    return (
      <div ref={dropdownRef} className={cn("relative inline-block", className)}>
        <button
          type="button"
          onClick={() => setIsOpen((o) => !o)}
          className={cn(
            "inline-flex items-stretch gap-8 rounded-[8px] border bg-grey-light-700 dark:bg-black-primary-bg px-4 py-2",
            "border-grey-dark-100 dark:border-black-300",
            "transition-colors hover:bg-grey-light-800 dark:hover:bg-black-300/70",
          )}
          aria-haspopup="menu"
          aria-expanded={isOpen}
        >
          <div className="flex flex-col items-start justify-center gap-[3px]">
            <div className="flex items-center gap-1">
              <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-primary-40/20">
                <span className="size-[6.15px] rounded-full bg-primary-40" />
              </span>
              <span className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
                Active Wallet
              </span>
            </div>
            <span className="text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-black-700 dark:text-grey-light-100">
              No Active Wallet
            </span>
          </div>

          {/* Right slot styled as its own dropdown pill — matches Figma:
              white bg + rounded border sitting inside the grey wrapper,
              so the trigger reads as a field, not flat text. */}
          <div
            className={cn(
              "flex items-center gap-2 rounded-[8px] border px-2.5 py-1.5",
              "border-grey-dark-100 bg-white dark:border-black-300 dark:bg-black-400",
            )}
          >
            <span className="font-mono text-[12px] font-medium uppercase text-grey-50 dark:text-grey-dark-600">
              Wallet Needed
            </span>
            <span
              className={cn(
                "flex items-center justify-center size-[17px] rounded border transition-all",
                "bg-[#EAEAEA] border-[#CECECE] dark:bg-[#3a3a3a] dark:border-[#555]",
              )}
            >
              <ChevronDown
                className={cn(
                  "size-2 shrink-0 text-[#8a8a8a] rotate-90 transition-transform dark:text-[#9a9a9a]",
                  isOpen && "rotate-0",
                )}
              />
            </span>
          </div>
        </button>

        {isOpen && (
          <div
            className={cn(
              "absolute right-0 top-full mt-1 z-50 w-[300px] rounded-[8px] border shadow-lg overflow-hidden",
              "border-grey-dark-100 bg-white dark:border-black-300 dark:bg-black-primary-bg",
            )}
            role="menu"
          >
            <div className="px-4 pt-4 pb-3">
              <h3 className="text-[14px] font-semibold text-grey-10 dark:text-grey-light-100">
                Wallet Required
              </h3>
              <p className="mt-1 text-[12px] leading-[16px] text-grey-50 dark:text-grey-dark-600">
                Create a new wallet or import an existing recovery
                phrase to start using Hippius.
              </p>
            </div>

            <div className="px-3 pb-3 flex flex-col gap-2">
              <Button
                variant="primaryLight"
                size="auto"
                onClick={handleCreate}
                role="menuitem"
                className="w-full justify-between gap-2 px-3 py-2 text-[13px] font-semibold"
              >
                <span className="flex items-center gap-2">
                  <Plus className="size-3.5" />
                  Create New Wallet
                </span>
                <ArrowRight className="size-3.5" />
              </Button>

              <Button
                variant="defaultStable"
                size="auto"
                onClick={handleImport}
                role="menuitem"
                className="w-full justify-between gap-2 px-3 py-2 text-[13px] font-semibold"
              >
                <span className="flex items-center gap-2">
                  <HardDriveUpload className="size-3.5" />
                  Import Your Wallet
                </span>
                <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={dropdownRef} className={cn("relative inline-block", className)}>
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        className={cn(
          "inline-flex items-stretch gap-8 rounded-[8px] border bg-grey-light-700 dark:bg-black-primary-bg px-4 py-2",
          "border-grey-dark-100 dark:border-black-300",
          "transition-colors hover:bg-grey-light-800 dark:hover:bg-black-300/70",
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="flex flex-col items-start justify-center gap-[3px]">
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

        <div
          className={cn(
            "flex items-center gap-2 rounded-[8px] border px-2.5 py-1.5",
            "border-grey-dark-100 bg-white dark:border-black-300 dark:bg-black-400",
          )}
        >
          <span className="font-mono text-[12px] font-medium uppercase text-black-700 dark:text-grey-light-100">
            {truncateAddress(activeWallet.address, 4, 4).toUpperCase()}
          </span>
          <span
            className={cn(
              "flex items-center justify-center size-[17px] rounded border transition-all",
              "bg-[#EAEAEA] border-[#CECECE] dark:bg-[#3a3a3a] dark:border-[#555]",
            )}
          >
            <ChevronDown
              className={cn(
                "size-2 shrink-0 text-[#8a8a8a] rotate-90 transition-transform dark:text-[#9a9a9a]",
                isOpen && "rotate-0",
              )}
            />
          </span>
        </div>
      </button>

      {isOpen && (
        <div
          className={cn(
            "absolute right-0 top-full mt-2 z-50 w-[380px] rounded-[12px] border shadow-lg overflow-visible",
            "border-[#e3e3e3] bg-white dark:border-black-300 dark:bg-black-600",
          )}
          role="listbox"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#e3e3e3] px-4 py-3 dark:border-black-300">
            <span className="font-geist text-[14px] font-semibold text-[#0a0a0a] dark:text-grey-light-100">
              Your Wallets
            </span>
            <button
              type="button"
              onClick={goToWalletSettings}
              className="flex size-7 items-center justify-center rounded-[6px] text-grey-50 transition-colors hover:bg-grey-light-700 hover:text-grey-10 dark:text-grey-dark-600 dark:hover:bg-black-400 dark:hover:text-grey-light-100"
              aria-label="Open wallet settings"
              title="Wallet settings"
            >
              <Settings className="size-4" />
            </button>
          </div>

          {/* Wallet rows */}
          <div className="max-h-[480px] space-y-3 overflow-y-auto p-3">
            {wallets.map((wallet) => {
              const isActive = activeWallet.id === wallet.id;
              return (
                <WalletRow
                  key={wallet.id}
                  name={wallet.name}
                  address={truncateAddress(wallet.address, 8, 6)}
                  fullAddress={wallet.address}
                  isActive={isActive}
                  onSelect={() => handleSwitch(wallet.id)}
                  onExplorer={(e) => {
                    e.stopPropagation();
                    void openShell(
                      `https://hipstats.com/accounts/${wallet.address}`,
                    );
                  }}
                  onExport={(e) => {
                    e.stopPropagation();
                    void handleExport(wallet.id, wallet.name);
                  }}
                />
              );
            })}
          </div>

          {/* Footer — Add another wallet */}
          <div className="border-t border-[#e3e3e3] dark:border-black-300">
            <button
              type="button"
              onClick={handleCreate}
              className="w-full flex items-center justify-center gap-2 px-3 py-3 text-[13px] font-medium text-primary-50 dark:text-primary-brand-dark hover:bg-[#f8f8f8] dark:hover:bg-black-500 transition-colors"
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

"use client";

import { useState, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Check, Loader2, Send } from "lucide-react";
import { CloseCircle, Refresh, TaoLogo } from "@/components/ui/icons";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { toast } from "sonner";
import { REFERRAL_CODE_CONFIG } from "@/lib/config";
import { useReferralLinks } from "@/app/lib/hooks/api/useReferralLinks";
import { AbstractIconWrapper } from "../../ui";

const ReferralLinkCard: React.FC = () => {
  const { links, loading, reload } = useReferralLinks();
  const [copied, setCopied] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  const { api, isConnected } = usePolkadotApi();
  const { walletManager } = useWalletAuth();

  // show only the first link
  const lastCode = useMemo(() => links[links?.length - 1]?.code ?? "", [links]);
  const fullLink = useMemo(
    () => `${REFERRAL_CODE_CONFIG.link}${lastCode}`,
    [lastCode]
  );

  const handleCopy = useCallback(async () => {
    await navigator.clipboard
      .writeText(fullLink)
      .then(() => toast.success("Copied to clipboard successfully!"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [fullLink]);

  const generateCode = useCallback(async () => {
    setGenerating(true);

    if (!api || !isConnected || !walletManager?.polkadotPair) {
      toast.error("Wallet Not Ready");
      setGenerating(false);
      return;
    }

    try {
      const unsub = await api.tx.credits
        .createReferralCode()
        .signAndSend(
          walletManager.polkadotPair,
          { nonce: -1 },
          ({ status, events, dispatchError }) => {
            if (dispatchError) {
              toast.error(`Transaction Failed: ${dispatchError.toString()}`);
              unsub();
              setGenerating(false);
              return;
            }
            if (status.isInBlock || status.isFinalized) {
              for (const { event } of events) {
                if (
                  event.section === "credits" &&
                  event.method === "ExtrinsicSuccess"
                ) {
                  break;
                }
              }
              unsub();
              setGenerating(false);
              setDialogOpen(false);
              toast.success("Referral Code Generated Successfully!");
              reload();
            }
          }
        );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Error Generating Code: ${message}`);
      setGenerating(false);
      setDialogOpen(false);
    }
  }, [api, isConnected, walletManager, reload]);

  return (
    <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
      <div className="bg-white p-3 rounded-lg border border-grey-80 shadow-sm h-[166px] relative bg-[url('/assets/refferal.png')] bg-repeat-round bg-cover">
        <div className="flex flex-col gap-4">
          <div className="flex justify-between items-center">
            <div className="flex gap-2">
              <AbstractIconWrapper className="size-10 text-primary-40">
                <TaoLogo className="absolute text-white rounded size-6 p-1 bg-primary-50" />
              </AbstractIconWrapper>
              <div className="text-primary-40 text-xs flex gap-x-1 font-medium items-center">
                <Send className="size-[18px]" />
                REFERRAL LINK
              </div>
            </div>
            <Dialog.Trigger asChild>
              <button className="flex items-center text-xs gap-1">
                <Refresh className="size-[18px] text-grey-60" />
                Refresh Link
              </button>
            </Dialog.Trigger>
          </div>
          <div className=" h-[86px] text-base leading-[22px] text-grey-60 flex flex-col justify-center">
            <span className=" mb-2">Your Referral Link</span>
            <div className="flex items-center justify-between rounded-[8px] p-3 border border-grey-80 bg-white">
              <div
                className="flex-1  whitespace-nowrap overflow-x-auto no-scrollbar"
                title={fullLink}
              >
                {loading ? (
                  <Loader2 className="animate-spin size-4" />
                ) : lastCode ? (
                  fullLink
                ) : (
                  <span className="text-red-400 text-sm font-medium">
                    No referral link found
                  </span>
                )}
              </div>
              {lastCode && (
                <button
                  onClick={handleCopy}
                  className="size-6 p-1 ml-2 flex items-center justify-center"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <Check className="w-6 h-6 text-green-500" />
                  ) : (
                    <Copy className="w-6 h-6" />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Dialog.Portal>
        <Dialog.Overlay className="bg-white/70 fixed inset-0 flex items-center justify-center data-[state=open]:animate-fade-in-0.3" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-[90%] max-w-sm -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg p-6 shadow-lg">
          <div className="flex justify-between items-center mb-4">
            <Dialog.Title className="text-xl font-semibold text-black">
              Allow Transaction
            </Dialog.Title>
            <Dialog.Close asChild>
              <button onClick={() => setGenerating(false)}>
                <CloseCircle className="size-6 text-black" />
              </button>
            </Dialog.Close>
          </div>
          <p className="mb-6 text-black">
            You’re about to create a new referral code on-chain. Please confirm.
          </p>
          <div className="flex justify-end space-x-2">
            <Dialog.Close asChild>
              <button
                onClick={() => setGenerating(false)}
                className="px-4 py-2 border rounded text-black"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={generateCode}
              disabled={generating}
              className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
            >
              {generating ? "Generating…" : "Generate"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ReferralLinkCard;

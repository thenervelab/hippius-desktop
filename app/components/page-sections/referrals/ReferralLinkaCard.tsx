"use client";

import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";
import { Refresh, TaoLogo } from "@/components/ui/icons";
import { toast } from "sonner";
import { AbstractIconWrapper } from "@/components/ui";

const ReferralLinkCard: React.FC = () => {
  // Feature disabled - use static empty data to prevent app hanging
  // The hooks depend on mnemonic which may not be available
  const loading = false;
  const lastCode = "";
  const fullLink = "";
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!fullLink) return;
    await navigator.clipboard
      .writeText(fullLink)
      .then(() => toast.success("Copied to clipboard successfully!"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [fullLink]);

  return (
    <div className="bg-white p-3 rounded-lg border border-grey-80 shadow-sm h-[166px] relative bg-[url('/assets/refferal.png')] bg-repeat-round bg-cover">
      <div className="flex flex-col gap-4">
        <div className="flex justify-between items-center">
          <div className="flex gap-2">
            <AbstractIconWrapper className="size-10 text-primary-40">
              <TaoLogo className="absolute text-white rounded size-6 p-1 bg-primary-50" />
            </AbstractIconWrapper>
            <div className="text-primary-40 text-xs flex gap-x-1 font-medium items-center">
              REFERRAL LINK
            </div>
          </div>
          <button className="flex items-center text-xs gap-1 cursor-not-allowed opacity-50">
            <Refresh className="size-[18px] text-grey-60" />
            {loading && !lastCode ? (
              <div className="h-4 w-20 bg-grey-70 rounded animate-pulse" />
            ) : lastCode ? (
              "Refresh Link"
            ) : (
              "Generate Link"
            )}
          </button>
        </div>
        <div className="h-[86px] text-base leading-[22px] text-grey-60 flex flex-col justify-center">
          <span className="mb-2">Your Referral Link</span>
          <div className="flex items-center justify-between rounded-[8px] p-3 border border-grey-80 bg-white">
            <div
              className="flex-1 whitespace-nowrap overflow-x-auto no-scrollbar"
              title={fullLink}
            >
              {lastCode ? (
                fullLink
              ) : (
                <div className="text-grey-60 text-sm font-medium">
                  Referral links coming soon
                </div>
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
  );
};

export default ReferralLinkCard;

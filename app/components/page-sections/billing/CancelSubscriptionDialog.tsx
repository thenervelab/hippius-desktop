"use client";

import { FC, useState } from "react";
import { CloseCircle } from "@/components/ui/icons";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";

export interface Plan {
  name: string;
  description?: string;
  credits_per_billing: number | string;
  interval: string;
  [key: string]: unknown;
}

interface CancelSubscriptionDialogProps {
  plans?: Plan[];
  onDialogOpenChange?: (open: boolean) => void;
  open?: boolean;
}

const CancelSubscriptionDialog: FC<CancelSubscriptionDialogProps> = ({
  onDialogOpenChange,
  open = false,
}) => {
  const [isCancelling, setIsCancelling] = useState(false);
  const { polkadotAddress } = useWalletAuth();

  const handleClose = () => {
    onDialogOpenChange?.(false);
  };

  const handleCancelSubscription = async () => {
    try {
      setIsCancelling(true);

      if (!polkadotAddress) {
        toast.error("Wallet address not available");
        return;
      }

      const data = await invoke<{ portal_url?: string }>(
        "get_customer_portal_url",
        {
          accountId: polkadotAddress,
          returnUrl: "https://console.hippius.com/dashboard/billing",
        },
      );

      if (data.portal_url) {
        handleClose();
        await openUrl(data.portal_url);
      } else {
        throw new Error("No portal URL returned");
      }
    } catch (error) {
      console.error("Error getting customer portal:", error);
      toast.error("Failed to open subscription management portal");
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Cancel Subscription?"
      icon={<CloseCircle className="size-5 text-white" />}
      iconBgClassName="bg-error-80"
      maxWidth="max-w-[560px]"
    >
      <p className="text-center text-[14px] font-medium leading-5 tracking-[-0.28px] text-[#52525c] dark:text-[#a3a3a3] mb-6">
        You&apos;ll be redirected to the Stripe customer portal where you can
        manage or cancel your subscription. Are you sure you want to proceed?
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="primaryLight"
          size="auto"
          className="flex-1 h-[38px] rounded-[8px] text-[14px] font-medium tracking-[-0.28px]"
          onClick={handleClose}
          disabled={isCancelling}
        >
          Keep Subscription
        </Button>
        <Button
          variant="destructive"
          size="auto"
          className="flex-1 h-[38px] rounded-[8px] text-[14px] font-medium tracking-[-0.28px]"
          onClick={handleCancelSubscription}
          loading={isCancelling}
        >
          Yes, Cancel
        </Button>
      </div>
    </FramedDialog>
  );
};

export default CancelSubscriptionDialog;

import React, { useState } from "react";
import { AbstractIconWrapper, CardButton, Icons } from "../../ui";
import { Zip } from "../../ui/icons";
import { exportWalletAsZip } from "../../../lib/helpers/exportWallet";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface ExportEncryptedSeedProps {
  className?: string;
}

const ExportEncryptedSeed: React.FC<ExportEncryptedSeedProps> = ({
  className,
}) => {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const success = await exportWalletAsZip();
      if (success) {
        toast.success("Backup file exported successfully", {
          duration: 3000,
        });
      }
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="w-full  relative bg-[url('/assets/subscription-bg-layer.png')] bg-repeat bg-cover">
      <div
        className={cn(
          "border flex justify-between flex-col relative border-grey-80 overflow-hidden rounded-xl w-full h-full",
          className
        )}
      >
        <div className="w-full  px-4 py-4 relative">
          <div className="flex items-start">
            <AbstractIconWrapper className="min-w-[40px] size-8 sm:size-10 text-primary-40">
              <Icons.Wallet className="absolute text-primary-40 size-4 sm:size-5" />
            </AbstractIconWrapper>
          </div>
          <div className="flex flex-col mt-4">
            <span className="text-base leading-[22px] font-medium mb-3 text-grey-60">
              Encrypted seed
            </span>
            <div className="text-[22px] leading-8 mb-1 font-medium text-grey-10">
              Export your encrypted seed
            </div>
            <div className="text-sm text-grey-60 mb-3">
              Download an encrypted backup for secure storage and recovery.
            </div>
          </div>
        </div>
        <div className="relative mx-[22px] pb-[22px]   bg-grey-100 w-auto">
          <CardButton
            className="w-full h-[60px]"
            variant="dialog"
            onClick={handleExport}
            disabled={isExporting}
          >
            <div className="flex items-center gap-2">
              <Zip className="size-4" />
              <span className="flex items-center">
                {isExporting ? "Downloading..." : "Download"}
              </span>
            </div>
          </CardButton>
        </div>
      </div>
    </div>
  );
};

export default ExportEncryptedSeed;

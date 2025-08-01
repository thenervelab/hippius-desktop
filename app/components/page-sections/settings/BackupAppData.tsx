import React, { useState } from "react";
import { CardButton, Icons, RevealTextLine } from "../../ui";
import { Zip } from "../../ui/icons";
import { exportWalletAsZip } from "../../../lib/helpers/exportWallet";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";
import SectionHeader from "./SectionHeader";

interface ExportEncryptedSeedProps {
  className?: string;
}

const BackupAppData: React.FC<ExportEncryptedSeedProps> = ({ className }) => {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const success = await exportWalletAsZip();
      if (success) {
        toast.success("Backup saved.", { duration: 3000 });
      }
    } catch (error) {
      console.error("Export failed:", error);
      toast.error("Backup failed.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className={cn(
            "flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover",
            className
          )}
        >
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <SectionHeader
              Icon={Icons.Wallet}
              title="Backup App Data"
              info="Regular backups help you recover your data stored on this device if you lose access to it. Store your backup ZIP file in a secure location that only you can access."
              subtitle="The ZIP includes your encrypted seed, sub‑account seeds, and notification data. Save it somewhere secure."
            />
          </RevealTextLine>

          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <CardButton
              className="h-[60px] w-[247px]"
              variant="dialog"
              onClick={handleExport}
              disabled={isExporting}
            >
              <div className="flex items-center gap-2">
                <Zip className="size-4" />
                <span>
                  {isExporting ? "Downloading..." : "Download Backup"}
                </span>
              </div>
            </CardButton>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default BackupAppData;

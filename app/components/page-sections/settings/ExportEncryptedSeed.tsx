import React, { useState } from "react";
import { RevealTextLine } from "../../ui";
import { CardButton } from "../../ui";
import { Zip } from "../../ui/icons";
import { exportWalletAsZip } from "../../../lib/helpers/exportWallet";

interface ExportEncryptedSeedProps {
  inView: boolean;
}

const ExportEncryptedSeed: React.FC<ExportEncryptedSeedProps> = ({
  inView,
}) => {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const success = await exportWalletAsZip();
      if (success) {
        // Optional: Show success message
        console.log("Wallet exported successfully");
      } else {
        // Optional: Show error message
        console.log("Export cancelled or failed");
      }
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex items-center mb-5">
      <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
        <div className="w-[260px] text-grey-10 text-lg font-medium">
          Export encrypted seed
        </div>
      </RevealTextLine>
      <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
        <CardButton
          className="h-[40px] w-fit p-1"
          onClick={handleExport}
          disabled={isExporting}
        >
          <div className="flex items-center gap-2 text-grey-100 text-base font-medium p-2">
            <div>
              <Zip className="size-4" />
            </div>
            <span className="flex items-center">
              {isExporting ? "Exporting..." : "Download Zip"}
            </span>
          </div>
        </CardButton>
      </RevealTextLine>
    </div>
  );
};

export default ExportEncryptedSeed;

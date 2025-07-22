import React, { useState } from "react";
import { CardButton, Icons, RevealTextLine } from "../../ui";
import { Trash } from "../../ui/icons";
import { InView } from "react-intersection-observer";
import ResetDataConfirmation from "./ResetDataConfirmation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { toast } from "sonner";
import SectionHeader from "./SectionHeader";
import { useSetAtom } from "jotai";
import { settingsDialogOpenAtom } from "@/app/components/sidebar/sideBarAtoms";

const ResetAppData = () => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const { resetWallet } = useWalletAuth();
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);

  const openDialog = () => setIsDialogOpen(true);
  const closeDialog = () => setIsDialogOpen(false);

  const handleResetLocalData = async () => {
    setIsResetting(true);
    try {
      await resetWallet();
      toast.success(
        "Local data cleared. You can restore everything with your backup.",
        {
          duration: 4000
        }
      );
      setSettingsDialogOpen(false);
    } catch (error) {
      console.error("Failed to reset local data:", error);
      toast.error("Failed to reset local data");
      setIsResetting(false);
    } finally {
      closeDialog();
      setIsResetting(false);
    }
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4"
        >
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <SectionHeader
              Icon={Icons.Trash}
              title="Reset App Data"
              subtitle="This will erase all Hippius data stored on this device. On‑chain data and IPFS files stay intact and can be restored."
            />
          </RevealTextLine>

          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <CardButton
              className="text-base h-[60px]"
              variant="error"
              onClick={openDialog}
            >
              <div className="flex items-center gap-2">
                <Trash className="size-4" />
                <span>Reset App Data</span>
              </div>
            </CardButton>
          </RevealTextLine>

          <ResetDataConfirmation
            open={isDialogOpen}
            onClose={closeDialog}
            onConfirm={handleResetLocalData}
            onBack={closeDialog}
            loading={isResetting}
          />
        </div>
      )}
    </InView>
  );
};

export default ResetAppData;

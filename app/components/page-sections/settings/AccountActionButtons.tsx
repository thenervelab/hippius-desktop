import React, { useState } from "react";
import { CardButton, Icons, RevealTextLine } from "../../ui";
import { Trash } from "../../ui/icons";
import { InView } from "react-intersection-observer";
import DeleteAccountConfirmation from "./DeleteAccountConfirmation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { toast } from "sonner";
import SectionHeader from "./SectionHeader";
import { useSetAtom } from "jotai";
import { settingsDialogOpenAtom } from "@/app/components/sidebar/sideBarAtoms";

const AccountActionButtons = () => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { resetWallet } = useWalletAuth();
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);

  const handleOpenDeleteDialog = () => setIsDeleteDialogOpen(true);
  const handleCloseDeleteDialog = () => setIsDeleteDialogOpen(false);

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      await resetWallet();

      toast.success("Your account has been successfully deleted", {
        duration: 4000
      });

      setSettingsDialogOpen(false);
    } catch (error) {
      console.log("Failed to delete account:", error);
      toast.error(`Failed to delete account`);
      setIsDeleting(false);
    } finally {
      handleCloseDeleteDialog();
      setIsDeleting(false);
    }
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex gap-6 w-full flex-col border broder-grey-80 rounded-lg p-4"
        >
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <SectionHeader
              Icon={Icons.Trash}
              title="Remove Your Account"
              subtitle="Deleting your account will erase all Hippius data stored on this device. Make sure you back up encrypted seed before you proceed."
            />
          </RevealTextLine>

          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <CardButton
              className="text-base"
              variant="error"
              onClick={handleOpenDeleteDialog}
            >
              <div className="flex items-center gap-2">
                <Trash className="size-4" />
                <span>Delete Account</span>
              </div>
            </CardButton>
          </RevealTextLine>

          <DeleteAccountConfirmation
            open={isDeleteDialogOpen}
            onClose={handleCloseDeleteDialog}
            onDelete={handleDeleteAccount}
            onBack={handleCloseDeleteDialog}
            loading={isDeleting}
          />
        </div>
      )}
    </InView>
  );
};

export default AccountActionButtons;

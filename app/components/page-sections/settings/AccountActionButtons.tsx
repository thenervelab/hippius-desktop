import React, { useState } from "react";
import { CardButton, RevealTextLine } from "../../ui";
import { Trash } from "../../ui/icons";
import { InView } from "react-intersection-observer";
import DeleteAccountConfirmation from "./DeleteAccountConfirmation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { toast } from "sonner";

const AccountActionButtons = () => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { resetWallet } = useWalletAuth();

  const handleOpenDeleteDialog = () => setIsDeleteDialogOpen(true);
  const handleCloseDeleteDialog = () => setIsDeleteDialogOpen(false);

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      await resetWallet();

      toast.success("Your account has been successfully deleted", {
        duration: 4000,
      });
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
        <div ref={ref} className="flex gap-6  w-full">
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <div className="flex gap-0.5 flex-col">
              <div className="text-grey-10 text-lg leading-6 font-medium ">
                Remove Your Account
              </div>
              <div className="text-sm text-grey-60 ">
                This will permanently remove your account. Ensure you have a
                backup first.
              </div>
            </div>
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

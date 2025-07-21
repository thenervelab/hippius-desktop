import React, { useState } from "react";
import { Icons, RevealTextLine, IconButton } from "../../ui";
import { InView } from "react-intersection-observer";
import DeleteAccountConfirmation from "./DeleteAccountConfirmation";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { toast } from "sonner";
import SectionHeader from "./SectionHeader";
import { useSetAtom } from "jotai";
import { settingsDialogOpenAtom } from "@/app/components/sidebar/sideBarAtoms";
import { PlusCircle } from "lucide-react";

const EncryptionKey = () => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { resetWallet } = useWalletAuth();
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);

  const handleCloseDeleteDialog = () => setIsDeleteDialogOpen(false);

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      await resetWallet();

      toast.success("Your account has been successfully deleted", {
        duration: 4000,
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
          className="flex gap-12 w-full flex-col border broder-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover"
        >
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <div className="w-full flex justify-between">
              <SectionHeader
                Icon={Icons.ShieldSecurity}
                title="Encryption Key"
                subtitle="This encryption key is used to securely save your files."
              />
              <IconButton
                icon={PlusCircle}
                text="New Encryption Key  "
                onClick={() => {}}
              />
            </div>
          </RevealTextLine>
          {/* 
          <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
            <IconButton
              outerPadding="p-1.5"
              innerPadding="px-6 py-2.5"
              fontSizeClass="text-lg"
              innerClassName="h-12"
              text="View Encryption Key  "
              onClick={() => {}}
            />
          </RevealTextLine> */}

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

export default EncryptionKey;

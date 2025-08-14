import React, { useState } from "react";
import { CardButton, Icons, RevealTextLine } from "@/components/ui";
import { Zip } from "@/components/ui/icons";
import { exportHippiusDBDataAsZip } from "@/app/lib/helpers/exportHippiusDB";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";
import SectionHeader from "./SectionHeader";
import * as Dialog from "@radix-ui/react-dialog";
import PasscodeInput from "@/components/page-sections/settings/encryption-key/PasscodeInput";
import DialogContainer from "@/components/ui/DialogContainer";

interface ExportEncryptedSeedProps {
  className?: string;
}

const BackupAppData: React.FC<ExportEncryptedSeedProps> = ({ className }) => {
  const [isExporting, setIsExporting] = useState(false);
  const [showPasscodeModal, setShowPasscodeModal] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [showPasscode, setShowPasscode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    setShowPasscodeModal(true);
  };

  const handlePasscodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode) {
      setError("Please enter your passcode");
      return;
    }

    setIsExporting(true);
    setError(null);

    try {
      const success = await exportHippiusDBDataAsZip(passcode);
      if (success) {
        toast.success("Backup saved.", { duration: 3000 });
        closePasscodeModal();
      }
    } catch (error) {
      console.error("Export failed:", error);
      if ((error as Error).message === "Invalid passcode") {
        setError("Incorrect passcode. Please try again.");
      } else {
        toast.error("Backup failed.");
        closePasscodeModal();
      }
    } finally {
      setIsExporting(false);
    }
  };

  const closePasscodeModal = () => {
    setShowPasscodeModal(false);
    setPasscode("");
    setShowPasscode(false);
    setError(null);
  };

  return (
    <>
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
                subtitle="The ZIP includes your encrypted seed, sub‑account seeds, notification data, and backend data. Save it somewhere secure."
              />
            </RevealTextLine>

            <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
              <CardButton
                className="h-[48px] w-[247px]"
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

      <Dialog.Root open={showPasscodeModal} onOpenChange={setShowPasscodeModal}>
        <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit">
          <Dialog.Title className="text-center text-2xl text-grey-10 font-medium pt-4">
            Enter Passcode
          </Dialog.Title>

          <div className="p-4 pt-0">
            <div className="text-grey-20 text-center">
              Enter your passcode to backup your app data
            </div>

            <form onSubmit={handlePasscodeSubmit}>
              <PasscodeInput
                passcode={passcode}
                onPasscodeChange={setPasscode}
                showPasscode={showPasscode}
                onToggleShowPasscode={() => setShowPasscode(!showPasscode)}
                error={error}
                inView={true}
                placeholder="Enter your passcode"
                label="Enter your passcode"
              />

              <div className="flex gap-4 mt-6">
                <CardButton
                  className="w-full"
                  variant="secondary"
                  onClick={closePasscodeModal}
                  disabled={isExporting}
                >
                  Cancel
                </CardButton>

                <CardButton
                  className="w-full"
                  variant="primary"
                  type="submit"
                  disabled={isExporting}
                  loading={isExporting}
                >
                  {isExporting ? "Creating Backup..." : "Backup Now"}
                </CardButton>
              </div>
            </form>
          </div>
        </DialogContainer>
      </Dialog.Root>
    </>
  );
};

export default BackupAppData;

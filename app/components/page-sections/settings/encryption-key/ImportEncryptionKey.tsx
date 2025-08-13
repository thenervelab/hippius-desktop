/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState } from "react";
import { Icons, RevealTextLine, IconButton, BackButton } from "@/components/ui";
import { toast } from "sonner";
import SectionHeader from "@/components/page-sections/settings/SectionHeader";
import { getWalletRecord } from "@/app/lib/helpers/hippiusDesktopDB";
import { hashPasscode } from "@/app/lib/helpers/crypto";
import PasscodeInput from "./PasscodeInput";
import { invoke } from "@tauri-apps/api/core";
import ImportEncryptionKeyDialog from "./ImportEncryptionKeyDialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui";
import { AlertCircle } from "lucide-react";

interface ImportEncryptionKeyProps {
  inView: boolean;
  onBack: () => void;
  onKeyImported: () => void;
  importedKey: string;
}

const ImportEncryptionKey: React.FC<ImportEncryptionKeyProps> = ({
  inView,
  onBack,
  onKeyImported,
  importedKey,
}) => {
  const [encryptionKey, setEncryptionKey] = useState("");
  const [passcode, setPasscode] = useState("");
  const [showPasscode, setShowPasscode] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleToggleShowPasscode = () => {
    setShowPasscode(!showPasscode);
  };

  const copyToClipboard = async () => {
    if (!importedKey) return;

    try {
      await navigator.clipboard.writeText(importedKey);
      setCopied(true);
      toast.success("Encryption key copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error("Failed to copy to clipboard");
      console.log("Copy failed:", error);
    }
  };

  const handleImportKey = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!encryptionKey.trim()) {
      setKeyError("Please enter an encryption key");
      return;
    }

    if (!passcode) {
      setError("Please enter your passcode");
      return;
    }

    setIsImporting(true);
    setError(null);
    setKeyError(null);

    try {
      const record = await getWalletRecord();
      if (!record) throw new Error("No wallet record found");
      if (hashPasscode(passcode) !== record.passcodeHash)
        throw new Error("Incorrect passcode");

      await invoke<string>("import_key", { keyBase64: encryptionKey.trim() });

      setShowDialog(true);
      setEncryptionKey("");
      setPasscode("");
      onKeyImported();
    } catch (error: any) {
      if (error.message.includes("Incorrect passcode")) {
        setError("Incorrect passcode. Please try again.");
      } else if (error.includes("Invalid base64")) {
        setKeyError("Invalid encryption key. Please try again.");
      } else if (error.includes("Invalid key length")) {
        setKeyError("Invalid encryption key length");
      } else {
        setError("Failed to import key. Please try again.");
      }
      console.log("Key import failed:", error);
    } finally {
      setIsImporting(false);
    }
  };

  const handleDialogClose = () => {
    setShowDialog(false);
    onBack();
  };

  return (
    <>
      <RevealTextLine
        rotate
        reveal={inView}
        parentClassName="w-full"
        className="delay-300 w-full"
      >
        <div className="w-full flex flex-col gap-4">
          <BackButton onBack={onBack} />
          <SectionHeader
            Icon={Icons.ShieldSecurity}
            title="Import Encryption Key"
            subtitle="Import an existing encryption key to access your encrypted files."
          />
        </div>
      </RevealTextLine>

      <form className="flex flex-col" onSubmit={handleImportKey}>
        <RevealTextLine
          rotate
          reveal={inView}
          parentClassName="w-full"
          className="delay-300 w-full mt-8"
        >
          <div className="space-y-1 text-grey-10 w-full flex flex-col">
            <Label
              htmlFor="import-encryption-key"
              className="text-sm font-medium text-grey-70"
            >
              Enter encryption key to import
            </Label>
            <div className="relative flex items-start w-full">
              <Icons.Key className="size-6 absolute left-3 top-[28px] transform -translate-y-1/2 text-grey-60" />
              <Input
                id="import-encryption-key"
                placeholder="Paste your encryption key here"
                type="text"
                value={encryptionKey}
                onChange={(e) => setEncryptionKey(e.target.value)}
                className="px-11 border-grey-80 h-14 text-grey-30 w-full
                bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none 
                hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus bg-white"
              />
            </div>
            {keyError && (
              <div className="flex text-error-70 text-sm font-medium items-center gap-2 mt-2">
                <AlertCircle className="size-4 !relative" />
                <span>{keyError}</span>
              </div>
            )}
          </div>
        </RevealTextLine>

        <PasscodeInput
          passcode={passcode}
          onPasscodeChange={setPasscode}
          showPasscode={showPasscode}
          onToggleShowPasscode={handleToggleShowPasscode}
          error={error}
          inView={inView}
          label="Enter your passcode to verify"
          placeholder="Enter your passcode here"
        />

        <RevealTextLine
          rotate
          reveal={inView}
          className="delay-300 w-full mt-6"
        >
          <IconButton
            type="submit"
            outerPadding="p-[5px]"
            innerPadding="px-6 py-2.5"
            fontSizeClass="text-lg"
            innerClassName="h-9"
            text={isImporting ? "Importing..." : "Import Key"}
            onClick={handleImportKey}
            disabled={isImporting || !passcode || !encryptionKey.trim()}
          />
        </RevealTextLine>
      </form>

      {importedKey && (
        <ImportEncryptionKeyDialog
          open={showDialog}
          inView={inView}
          onClose={handleDialogClose}
          copyToClipboard={copyToClipboard}
          importedMnemonic={importedKey}
          copied={copied}
          customWarnings={[
            {
              id: 1,
              text: "Your encryption key has been successfully imported",
            },
            {
              id: 2,
              text: "This key will be used to decrypt your encrypted files",
            },
            {
              id: 3,
              text: "Keep this key secure and do not share it with anyone",
            },
          ]}
          onDone={handleDialogClose}
        />
      )}
    </>
  );
};

export default ImportEncryptionKey;

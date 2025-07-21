import React, { useState } from "react";
import { Icons, RevealTextLine, IconButton } from "@/components/ui";
import { toast } from "sonner";
import SectionHeader from "../SectionHeader";
import { getWalletRecord } from "@/app/lib/helpers/walletDb";
import { hashPasscode } from "@/app/lib/helpers/crypto";
import PasscodeInput from "./PasscodeInput";
import { invoke } from "@tauri-apps/api/core";
import GenerateNewKeyDialog from "./GenerateNewKeyDialog";

interface GenerateNewKeyProps {
  inView: boolean;
  onBack: () => void;
  onKeyGenerated: () => void;
  generatedKey: string;
}

const GenerateNewKey: React.FC<GenerateNewKeyProps> = ({
  inView,
  onBack,
  onKeyGenerated,
  generatedKey,
}) => {
  const [passcode, setPasscode] = useState("");
  const [showPasscode, setShowPasscode] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleToggleShowPasscode = () => {
    setShowPasscode(!showPasscode);
  };

  const copyToClipboard = async () => {
    if (!generatedKey) return;

    try {
      await navigator.clipboard.writeText(generatedKey);
      setCopied(true);
      toast.success("Encryption key copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast.error("Failed to copy to clipboard");
      console.log("Copy failed:", error);
    }
  };

  const handleGenerateKey = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!passcode) {
      setError("Please enter your passcode");
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const record = await getWalletRecord();
      if (!record) throw new Error("No wallet record found");
      if (hashPasscode(passcode) !== record.passcodeHash)
        throw new Error("Incorrect passcode");

      // Generate the encryption key
      await invoke<string>("create_encryption_key");

      setShowDialog(true);
      setPasscode("");
      onKeyGenerated();
    } catch (error) {
      setError("Incorrect passcode. Please try again.");
      console.log("Key generation failed:", error);
    } finally {
      setIsGenerating(false);
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
        <div className="w-full flex flex-col gap-4 ">
          <button
            className="flex gap-2 font-semibold text-lg items-center"
            onClick={onBack}
          >
            <Icons.ArrowLeft className="size-5 text-grey-10" />
            Back
          </button>
          <SectionHeader
            Icon={Icons.ShieldSecurity}
            title="Generate New Key"
            subtitle="Create a new encryption key to securely save your files."
          />
        </div>
      </RevealTextLine>

      <form className="flex flex-col" onSubmit={handleGenerateKey}>
        <PasscodeInput
          passcode={passcode}
          onPasscodeChange={setPasscode}
          showPasscode={showPasscode}
          onToggleShowPasscode={handleToggleShowPasscode}
          error={error}
          inView={inView}
          label="Enter your Passcode to generate a new key"
          placeholder="Enter your passcode here"
        />

        <RevealTextLine
          rotate
          reveal={inView}
          className="delay-300 w-full mt-11"
        >
          <IconButton
            type="submit"
            outerPadding="p-1.5"
            innerPadding="px-6 py-2.5"
            fontSizeClass="text-lg"
            innerClassName="h-12"
            text={isGenerating ? "Generating..." : "Generate New Key"}
            onClick={handleGenerateKey}
            disabled={isGenerating || !passcode}
          />
        </RevealTextLine>
      </form>

      {generatedKey && (
        <GenerateNewKeyDialog
          open={showDialog}
          inView={inView}
          onClose={handleDialogClose}
          copyToClipboard={copyToClipboard}
          generatedMnemonic={generatedKey}
          copied={copied}
          customWarnings={[
            {
              id: 1,
              text: "Store this encryption key in a secure password manager",
            },
            {
              id: 2,
              text: "This key is required to decrypt your private files",
            },
            {
              id: 3,
              text: (
                <div>
                  We <b>cannot</b> help you recover your files if you lose this
                  key
                </div>
              ),
            },
          ]}
          onDone={handleDialogClose}
        />
      )}
    </>
  );
};

export default GenerateNewKey;

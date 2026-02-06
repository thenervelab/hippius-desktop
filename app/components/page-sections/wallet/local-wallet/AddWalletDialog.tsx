"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Icons, Graphsheet, Input } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import PasscodeInput from "./PasscodeInput";
import { ArrowRight, AlertCircle, Copy, Check, AlertTriangle, X } from "lucide-react";
import { toast } from "sonner";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";


interface AddWalletDialogProps {
  open: boolean;
  onClose: () => void;
}

type AddWalletStep = "create-mnemonic" | "create-passcode" | "import";

const AddWalletDialog: React.FC<AddWalletDialogProps> = ({ open, onClose }) => {
  const { generateMnemonic, createWallet, importWallet } = useLocalWallet();

  const [step, setStep] = useState<AddWalletStep>("create-mnemonic");
  const [mnemonic, setMnemonic] = useState("");
  const [walletName, setWalletName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [confirmPasscode, setConfirmPasscode] = useState("");
  const [importMnemonic, setImportMnemonic] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Generate mnemonic when dialog opens
  React.useEffect(() => {
    if (open && step === "create-mnemonic" && !mnemonic) {
      const newMnemonic = generateMnemonic();
      setMnemonic(newMnemonic);
    }
  }, [open, step, mnemonic, generateMnemonic]);

  const resetState = () => {
    setStep("create-mnemonic");
    setMnemonic("");
    setWalletName("");
    setPasscode("");
    setConfirmPasscode("");
    setImportMnemonic("");
    setError(null);
    setIsLoading(false);
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const handleImport = () => {
    setStep("import");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const handleProceedToPasscode = () => {
    if (!walletName.trim()) {
      setError("Please enter a wallet name");
      return;
    }
    setError(null);
    setStep("create-passcode");
  };

  const handleCreateWallet = async () => {
    setError(null);

    if (!passcode) {
      setError("Please enter a passcode");
      return;
    }

    if (passcode.length < 6) {
      setError("Passcode must be at least 6 characters");
      return;
    }

    if (passcode !== confirmPasscode) {
      setError("Passcodes do not match");
      return;
    }

    setIsLoading(true);

    try {
      const success = await createWallet(walletName || "New Wallet", mnemonic, passcode);

      if (success) {
        toast.success("Wallet created successfully!");
        handleClose();
      } else {
        setError("Failed to create wallet. This wallet may already exist.");
      }
    } catch (err) {
      console.error("Failed to create wallet:", err);
      setError(err instanceof Error ? err.message : "Failed to create wallet");
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportWallet = async () => {
    setError(null);

    if (!importMnemonic.trim()) {
      setError("Please enter your mnemonic");
      return;
    }

    if (!isMnemonicValid(importMnemonic.trim())) {
      setError("Invalid mnemonic phrase");
      return;
    }

    if (!passcode) {
      setError("Please enter a passcode");
      return;
    }

    if (passcode.length < 6) {
      setError("Passcode must be at least 6 characters");
      return;
    }

    setIsLoading(true);

    try {
      const success = await importWallet(
        walletName || "Imported Wallet",
        importMnemonic.trim(),
        passcode
      );

      if (success) {
        toast.success("Wallet imported successfully!");
        handleClose();
      } else {
        setError("Failed to import wallet. This wallet may already exist.");
      }
    } catch (err) {
      console.error("Failed to import wallet:", err);
      setError(err instanceof Error ? err.message : "Failed to import wallet");
    } finally {
      setIsLoading(false);
    }
  };

  const renderCreateMnemonicStep = () => (
    <div className="flex flex-col items-center px-6 py-8">
      <div className="size-10 flex justify-center items-center relative">
        <Graphsheet
          majorCell={{
            lineColor: [31, 80, 189, 1.0],
            lineWidth: 2,
            cellDim: 200,
          }}
          minorCell={{
            lineColor: [49, 103, 211, 1.0],
            lineWidth: 1,
            cellDim: 20,
          }}
          className="absolute w-full h-full duration-500 opacity-30 z-0"
        />
        <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
        <div className="h-7 w-7 bg-primary-50 rounded-lg flex items-center justify-center z-20">
          <Icons.HippiusLogo className="size-6 text-grey-100" />
        </div>
      </div>

      <h2 className="text-2xl font-medium text-grey-10 mt-4 mb-2">Add Wallet</h2>
      <p className="text-base text-grey-60 text-center mb-6">
        Create a new wallet or import an existing one
      </p>

      {/* Wallet Name Input */}
      <div className="w-full mb-4">
        <label className="text-sm font-medium text-grey-70 mb-2 block">
          Wallet Name
        </label>
        <Input
          type="text"
          value={walletName}
          onChange={(e) => {
            setWalletName(e.target.value);
            setError(null);
          }}
          placeholder="Choose a name for your wallet"
          className="w-full h-14 text-grey-10"
        />
      </div>

      {/* Mnemonic Display */}
      <div className="w-full mb-4">
        <label className="text-sm font-medium text-grey-60 mb-2 block">
          Your Mnemonic
        </label>
        <div className="relative border border-grey-80 rounded-lg p-4 bg-grey-98">
          <p className="pr-10 text-grey-10 font-medium leading-relaxed text-sm">
            {mnemonic}
          </p>
          <button
            onClick={handleCopy}
            className="absolute right-4 top-4 text-grey-50 hover:text-grey-30 transition-colors"
          >
            {copied ? (
              <Check className="size-5 text-success-50" />
            ) : (
              <Copy className="size-5" />
            )}
          </button>
        </div>
      </div>

      {/* Warning */}
      <div className="w-full mb-6 p-3 bg-error-95 border border-error-80 rounded-lg">
        <div className="flex items-start gap-3">
          <AlertTriangle className="size-4 text-error-60 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-grey-30">
            Store this mnemonic securely. We cannot help you recover it.
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <CardButton className="w-full h-12 mb-6" onClick={handleProceedToPasscode}>
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          Continue
          <ArrowRight className="size-5" />
        </div>
      </CardButton>

      {/* Import option */}
      <button
        onClick={handleImport}
        className="text-base text-grey-50 hover:text-grey-30 transition-colors"
      >
        Have an existing wallet?{" "}
        <span className="font-semibold text-grey-10">Import Your Wallet</span>
      </button>
    </div>
  );

  const renderCreatePasscodeStep = () => (
    <div className="flex flex-col items-center px-6 py-8">
      <div className="mb-6">
        <Icons.HippiusLogo className="size-16" />
      </div>

      <h2 className="text-2xl font-semibold text-grey-10 mb-2">Set Passcode</h2>
      <p className="text-base text-grey-60 text-center mb-8">
        Set a passcode to secure your wallet
      </p>

      <div className="w-full space-y-4 mb-6">
        <PasscodeInput
          value={passcode}
          onChange={(val) => {
            setPasscode(val);
            setError(null);
          }}
          label="Passcode"
          placeholder="Enter your passcode"
          disabled={isLoading}
        />

        <PasscodeInput
          value={confirmPasscode}
          onChange={(val) => {
            setConfirmPasscode(val);
            setError(null);
          }}
          label="Confirm Passcode"
          placeholder="Reenter passcode"
          disabled={isLoading}
          onSubmit={handleCreateWallet}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <CardButton
        className="w-full h-12"
        onClick={handleCreateWallet}
        disabled={isLoading}
        loading={isLoading}
      >
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          {isLoading ? "Creating..." : "Create Wallet"}
          {!isLoading && <ArrowRight className="size-5" />}
        </div>
      </CardButton>
    </div>
  );

  const renderImportStep = () => (
    <div className="flex flex-col items-center px-6 py-8">
      <div className="mb-6">
        <Icons.HippiusLogo className="size-16" />
      </div>

      <h2 className="text-2xl font-semibold text-grey-10 mb-6">Import Wallet</h2>

      {/* Wallet Name Input */}
      <div className="w-full mb-4">
        <label className="text-sm font-medium text-grey-60 mb-2 block">
          Wallet Name
        </label>
        <Input
          type="text"
          value={walletName}
          onChange={(e) => {
            setWalletName(e.target.value);
            setError(null);
          }}
          placeholder="Choose a name for your wallet"
          className="w-full h-14 text-grey-10"
          disabled={isLoading}
        />
      </div>

      {/* Mnemonic Input */}
      <div className="w-full mb-4">
        <label className="text-sm font-medium text-grey-60 mb-2 block">
          Mnemonic Phrase
        </label>
        <textarea
          value={importMnemonic}
          onChange={(e) => {
            setImportMnemonic(e.target.value);
            setError(null);
          }}
          placeholder="Enter your 12 or 24 word mnemonic phrase"
          className="w-full h-20 px-4 py-3 border border-grey-80 rounded-lg bg-transparent text-grey-10 text-sm placeholder:text-grey-60 outline-none transition-all duration-300 hover:shadow-input-focus focus:shadow-input-focus resize-none"
          disabled={isLoading}
        />
      </div>

      {/* Passcode Input */}
      <div className="w-full mb-6">
        <PasscodeInput
          value={passcode}
          onChange={(val) => {
            setPasscode(val);
            setError(null);
          }}
          label="Passcode"
          placeholder="Set a passcode for this wallet"
          disabled={isLoading}
          onSubmit={handleImportWallet}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <CardButton
        className="w-full h-12"
        onClick={handleImportWallet}
        disabled={isLoading || !importMnemonic.trim() || !passcode}
        loading={isLoading}
      >
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          {isLoading ? "Importing..." : "Import Wallet"}
          {!isLoading && <ArrowRight className="size-5" />}
        </div>
      </CardButton>
    </div>
  );

  const renderStep = () => {
    switch (step) {
      case "create-mnemonic":
        return renderCreateMnemonicStep();
      case "create-passcode":
        return renderCreatePasscodeStep();
      case "import":
        return renderImportStep();
      default:
        return renderCreateMnemonicStep();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit">
        <Dialog.Title className="sr-only">Add Wallet</Dialog.Title>

        {/* Back Button */}
        {step !== "create-mnemonic" && (
          <button
            onClick={() => {
              if (step === "create-passcode") {
                setStep("create-mnemonic");
              } else if (step === "import") {
                // Reset and go back to create mnemonic
                setImportMnemonic("");
                setPasscode("");
                setWalletName("");
                const newMnemonic = generateMnemonic();
                setMnemonic(newMnemonic);
                setStep("create-mnemonic");
              }
              setError(null);
            }}
            className="absolute left-4 top-4 text-grey-50 hover:text-grey-30 transition-colors z-10"
            disabled={isLoading}
          >
            <Icons.ArrowLeft className="size-5" />
          </button>
        )}

        {renderStep()}
      </DialogContainer>
    </Dialog.Root>
  );
};

export default AddWalletDialog;

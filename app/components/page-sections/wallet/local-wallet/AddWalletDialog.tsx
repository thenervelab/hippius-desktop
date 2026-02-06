"use client";

import React, { useState, useRef, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "@/components/ui/DialogContainer";
import { AbstractIconWrapper, CardButton, Icons, Graphsheet, Input } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import PasscodeInput from "./PasscodeInput";
import { ArrowRight, AlertCircle, Copy, Check, AlertTriangle, X } from "lucide-react";
import { toast } from "sonner";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";
import { decryptMnemonic } from "@/app/lib/helpers/crypto";
import BoxSimple from "@/components/ui/icons/BoxSimple";
import { cn } from "@/lib/utils";


interface AddWalletDialogProps {
  open: boolean;
  onClose: () => void;
}

// Steps:
// create-mnemonic: Generate new mnemonic for new wallet
// create-passcode: Set passcode for new wallet
// access-wallet: Enter existing mnemonic (like screenshot "Welcome to Hippius Wallet")
// access-passcode: Set passcode for accessed wallet
// import: Import from backup file only (drag-drop)
type AddWalletStep = "create-mnemonic" | "create-passcode" | "access-wallet" | "access-passcode" | "import";

const AddWalletDialog: React.FC<AddWalletDialogProps> = ({ open, onClose }) => {
  const { generateMnemonic, createWallet, importWallet } = useLocalWallet();

  const [step, setStep] = useState<AddWalletStep>("create-mnemonic");
  const [mnemonic, setMnemonic] = useState("");
  const [walletName, setWalletName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [confirmPasscode, setConfirmPasscode] = useState("");
  const [accessMnemonic, setAccessMnemonic] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  // Import file state
  const [importedFile, setImportedFile] = useState<{
    name: string;
    encryptedMnemonic: string;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setAccessMnemonic("");
    setError(null);
    setIsLoading(false);
    setImportedFile(null);
    setIsDragging(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // File handling functions
  const processFile = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.encryptedMnemonic) {
        setError("Invalid wallet backup file");
        return;
      }

      setImportedFile({
        name: data.name || "Imported Wallet",
        encryptedMnemonic: data.encryptedMnemonic,
      });
      setWalletName(data.name || "Imported Wallet");
      setError(null);
    } catch {
      setError("Failed to read wallet backup file");
    }
  };

  const handleFileDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const droppedFile = e.dataTransfer.files[0];
        await processFile(droppedFile);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    []
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        await processFile(file);
      }
    },
    []
  );

  const clearFile = () => {
    setImportedFile(null);
    setWalletName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleClose = () => {
    resetState();
    onClose();
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

  // Handle access wallet mnemonic validation
  const handleAccessNext = () => {
    const trimmed = accessMnemonic.trim();
    if (!trimmed) {
      setError("Please enter your mnemonic");
      return;
    }

    if (!isMnemonicValid(trimmed)) {
      setError("Invalid mnemonic phrase. Please check and try again.");
      return;
    }

    setError(null);
    setStep("access-passcode");
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

  // Handle access wallet passcode creation
  const handleAccessWalletCreate = async () => {
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
      const success = await importWallet(
        walletName || "My Wallet",
        accessMnemonic.trim(),
        passcode
      );

      if (success) {
        toast.success("Wallet accessed successfully!");
        handleClose();
      } else {
        setError("Failed to access wallet. This wallet may already exist.");
      }
    } catch (err) {
      console.error("Failed to access wallet:", err);
      setError(err instanceof Error ? err.message : "Failed to access wallet");
    } finally {
      setIsLoading(false);
    }
  };

  // Handle import from file
  const handleImportWallet = async () => {
    setError(null);

    if (!importedFile) {
      setError("Please select a backup file");
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
      let mnemonicToImport: string;

      try {
        mnemonicToImport = decryptMnemonic(
          importedFile.encryptedMnemonic,
          passcode
        );
        if (!isMnemonicValid(mnemonicToImport)) {
          setError("Incorrect passcode for this wallet backup");
          setIsLoading(false);
          return;
        }
      } catch {
        setError("Incorrect passcode for this wallet backup");
        setIsLoading(false);
        return;
      }

      const success = await importWallet(importedFile.name, mnemonicToImport, passcode);

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

  const renderLogo = () => (
    <div className="size-16 flex justify-center items-center relative mb-4">
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
      <div className="h-10 w-10 bg-primary-50 rounded-lg flex items-center justify-center z-20">
        <Icons.SplashHippiusLogo className="size-7" />
      </div>
    </div>
  );

  const renderCreateMnemonicStep = () => (
    <div className="flex flex-col items-center px-6 py-8">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-6">Create New Wallet</h2>

      {/* Wallet Name Input */}
      <div className="w-full mb-4">
        <label className="text-sm font-medium text-grey-70 mb-2 block">
          Wallet Name
        </label>
        <div className="relative">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-grey-50">
            <Icons.UserSquare className="size-5" />
          </div>
          <Input
            type="text"
            value={walletName}
            onChange={(e) => {
              setWalletName(e.target.value);
              setError(null);
            }}
            placeholder="Choose a name for your wallet"
            className="w-full h-14 pl-12 text-grey-10"
          />
        </div>
      </div>

      {/* Mnemonic Display */}
      <div className="w-full mb-4">
        <label className="text-sm font-medium text-grey-70 mb-2 block">
          Your Mnemonic
        </label>
        <div className="relative border border-grey-80 rounded-lg p-4 bg-grey-98">
          <div className="flex items-start gap-3">
            <Icons.Key className="size-5 text-grey-50 flex-shrink-0 mt-0.5" />
            <p className="pr-8 text-grey-10 font-medium leading-relaxed text-sm flex-1">
              {mnemonic}
            </p>
          </div>
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

      {/* Important Section */}
      <div className="w-full mb-6">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="size-4 text-warning-50" />
          <span className="text-sm font-semibold text-grey-10">IMPORTANT</span>
        </div>
        <ul className="space-y-2 text-sm text-grey-50">
          <li className="flex items-start gap-2">
            <ArrowRight className="size-4 text-grey-60 flex-shrink-0 mt-0.5" />
            <span>Store this mnemonic in a secure password manager</span>
          </li>
          <li className="flex items-start gap-2">
            <ArrowRight className="size-4 text-grey-60 flex-shrink-0 mt-0.5" />
            <span>Never share it with anyone</span>
          </li>
          <li className="flex items-start gap-2">
            <ArrowRight className="size-4 text-grey-60 flex-shrink-0 mt-0.5" />
            <span>We <strong className="text-grey-30">cannot</strong> help you recover your account if you lose this key</span>
          </li>
        </ul>
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
          Set Mnemonic
          <ArrowRight className="size-5" />
        </div>
      </CardButton>

      {/* Bottom options */}
      <div className="flex flex-col items-center gap-2">
        <button
          onClick={() => {
            setStep("access-wallet");
            setError(null);
          }}
          className="text-sm text-grey-50 hover:text-grey-30 transition-colors"
        >
          Already have a wallet?{" "}
          <span className="font-semibold text-grey-10">Access Wallet</span>
        </button>
        <button
          onClick={() => {
            setStep("import");
            setError(null);
          }}
          className="text-sm text-grey-50 hover:text-grey-30 transition-colors"
        >
          Have an existing wallet?{" "}
          <span className="font-semibold text-grey-10">Import Your Wallet</span>
        </button>
      </div>
    </div>
  );

  const renderCreatePasscodeStep = () => (
    <div className="flex flex-col items-center px-6 py-8">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-2">Set Passcode</h2>
      <p className="text-sm text-grey-60 text-center mb-6">
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

  // Access Wallet Step - Enter existing mnemonic (like the screenshot)
  const renderAccessWalletStep = () => (
    <div className="flex flex-col items-center px-6 py-8">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-2">Welcome to Hippius Wallet</h2>
      <p className="text-sm text-grey-60 text-center mb-6">
        Enter your wallet mnemonic to continue or create a new wallet
      </p>

      {/* Mnemonic Input */}
      <div className="w-full mb-6">
        <label className="text-sm font-medium text-grey-70 mb-2 block">
          Mnemonic
        </label>
        <div className="relative">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-grey-50">
            <Icons.Search className="size-5" />
          </div>
          <Input
            type="password"
            value={accessMnemonic}
            onChange={(e) => {
              setAccessMnemonic(e.target.value);
              setError(null);
            }}
            placeholder="Enter mnemonic"
            className="w-full h-14 pl-12 text-grey-10"
          />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <CardButton className="w-full h-12 mb-6" onClick={handleAccessNext}>
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          Next
          <ArrowRight className="size-5" />
        </div>
      </CardButton>

      {/* Bottom options */}
      <div className="flex flex-col items-center gap-2">
        <button
          onClick={() => {
            setStep("create-mnemonic");
            setAccessMnemonic("");
            setError(null);
            if (!mnemonic) {
              const newMnemonic = generateMnemonic();
              setMnemonic(newMnemonic);
            }
          }}
          className="text-sm text-grey-50 hover:text-grey-30 transition-colors"
        >
          Don&apos;t have a wallet?{" "}
          <span className="font-semibold text-grey-10">Create New Wallet</span>
        </button>
        <button
          onClick={() => {
            setStep("import");
            setAccessMnemonic("");
            setError(null);
          }}
          className="text-sm text-grey-50 hover:text-grey-30 transition-colors"
        >
          Have an existing wallet?{" "}
          <span className="font-semibold text-grey-10">Import Your Wallet</span>
        </button>
      </div>
    </div>
  );

  // Access Passcode Step - Set passcode for accessed wallet
  const renderAccessPasscodeStep = () => (
    <div className="flex flex-col items-center px-6 py-8">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-2">Set Passcode</h2>
      <p className="text-sm text-grey-60 text-center mb-6">
        Set a passcode to secure your wallet
      </p>

      {/* Wallet Name Input */}
      <div className="w-full mb-4">
        <label className="text-sm font-medium text-grey-70 mb-2 block">
          Wallet Name
        </label>
        <div className="relative">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-grey-50">
            <Icons.UserSquare className="size-5" />
          </div>
          <Input
            type="text"
            value={walletName}
            onChange={(e) => {
              setWalletName(e.target.value);
              setError(null);
            }}
            placeholder="Choose a name for your wallet"
            className="w-full h-14 pl-12 text-grey-10"
            disabled={isLoading}
          />
        </div>
      </div>

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
          onSubmit={handleAccessWalletCreate}
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
        onClick={handleAccessWalletCreate}
        disabled={isLoading}
        loading={isLoading}
      >
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          {isLoading ? "Accessing..." : "Access Wallet"}
          {!isLoading && <ArrowRight className="size-5" />}
        </div>
      </CardButton>
    </div>
  );

  // Import Step - ONLY file drag-drop (no mnemonic tab)
  const renderImportStep = () => (
    <div className="flex flex-col items-center px-6 py-8">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-6">Import Wallet</h2>

      {/* File Drop Zone */}
      {!importedFile ? (
        <div
          className={cn(
            "w-full rounded-lg h-[140px] p-2 transition mb-4",
            isDragging
              ? "bg-gray-50 border-2 border-dashed border-primary-50"
              : "border border-grey-80"
          )}
        >
          <div
            className="cursor-pointer border border-grey-80 rounded-xl border-dashed flex flex-col items-center justify-center h-full w-full transition"
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleFileDrop}
            onDragOver={(e) => e.preventDefault()}
            onDragEnter={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
          >
            <div className="mb-2">
              <AbstractIconWrapper className="size-8">
                <BoxSimple className="size-5 text-primary-50 absolute" />
              </AbstractIconWrapper>
            </div>
            <div className="text-sm font-medium text-grey-10">
              Upload a File Here
            </div>
            <div className="text-grey-60 text-xs">
              Drag & drop or click to add file
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>
        </div>
      ) : (
        <div className="w-full mb-4 p-4 bg-grey-98 border border-grey-80 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Icons.File className="size-5 text-primary-50" />
              <div>
                <p className="text-sm font-medium text-grey-10">
                  {importedFile.name}
                </p>
                <p className="text-xs text-grey-50">Wallet backup file</p>
              </div>
            </div>
            <button
              onClick={clearFile}
              className="p-1 text-grey-50 hover:text-grey-30 transition-colors"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* Passcode Input */}
      <div className="w-full mb-6">
        <PasscodeInput
          value={passcode}
          onChange={(val) => {
            setPasscode(val);
            setError(null);
          }}
          label="Passcode"
          placeholder="Enter the passcode used when exporting"
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
        className="w-full h-12 mb-6"
        onClick={handleImportWallet}
        disabled={isLoading || !passcode || !importedFile}
        loading={isLoading}
      >
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          {isLoading ? "Importing..." : "Import Wallet"}
          {!isLoading && <ArrowRight className="size-5" />}
        </div>
      </CardButton>

      {/* Bottom options */}
      <div className="flex flex-col items-center gap-2">
        <button
          onClick={() => {
            setStep("create-mnemonic");
            setPasscode("");
            setImportedFile(null);
            setError(null);
            if (!mnemonic) {
              const newMnemonic = generateMnemonic();
              setMnemonic(newMnemonic);
            }
          }}
          className="text-sm text-grey-50 hover:text-grey-30 transition-colors"
          disabled={isLoading}
        >
          Don&apos;t have a wallet?{" "}
          <span className="font-semibold text-grey-10">Create New Wallet</span>
        </button>
        <button
          onClick={() => {
            setStep("access-wallet");
            setPasscode("");
            setImportedFile(null);
            setError(null);
          }}
          className="text-sm text-grey-50 hover:text-grey-30 transition-colors"
          disabled={isLoading}
        >
          Already have a wallet?{" "}
          <span className="font-semibold text-grey-10">Access Wallet</span>
        </button>
      </div>
    </div>
  );

  const renderStep = () => {
    switch (step) {
      case "create-mnemonic":
        return renderCreateMnemonicStep();
      case "create-passcode":
        return renderCreatePasscodeStep();
      case "access-wallet":
        return renderAccessWalletStep();
      case "access-passcode":
        return renderAccessPasscodeStep();
      case "import":
        return renderImportStep();
      default:
        return renderCreateMnemonicStep();
    }
  };

  const handleBack = () => {
    if (step === "create-passcode") {
      setStep("create-mnemonic");
    } else if (step === "access-passcode") {
      setStep("access-wallet");
    } else if (step === "import" || step === "access-wallet") {
      // Reset and go back to create mnemonic
      setAccessMnemonic("");
      setPasscode("");
      setWalletName("");
      setImportedFile(null);
      if (!mnemonic) {
        const newMnemonic = generateMnemonic();
        setMnemonic(newMnemonic);
      }
      setStep("create-mnemonic");
    }
    setError(null);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContainer className="md:inset-0 md:m-auto w-[430px] h-fit">
        <Dialog.Title className="sr-only">Add Wallet</Dialog.Title>

        {/* Back Button */}
        {step !== "create-mnemonic" && (
          <button
            onClick={handleBack}
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

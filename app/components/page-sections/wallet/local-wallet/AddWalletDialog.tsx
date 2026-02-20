"use client";

import React, { useState, useRef, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "@/components/ui/DialogContainer";
import { AbstractIconWrapper, CardButton, Icons, Graphsheet, Input } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import PasswordInput from "./PasswordInput";
import { ArrowRight, AlertCircle, Copy, Check, AlertTriangle, X } from "lucide-react";
import { toast } from "sonner";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";
import BoxSimple from "@/components/ui/icons/BoxSimple";
import { cn } from "@/lib/utils";
import JSZip from "jszip";


interface AddWalletDialogProps {
  open: boolean;
  onClose: () => void;
  initialStep?: AddWalletStep;
}

// Steps:
// create-mnemonic: Generate new mnemonic for new wallet
// create-password: Set password for new wallet
// access-wallet: Enter existing mnemonic (like screenshot "Welcome to Hippius Wallet")
// access-password: Set password for accessed wallet
// import: Import from backup file only (drag-drop)
type AddWalletStep = "create-mnemonic" | "create-password" | "access-wallet" | "access-password" | "import";

const AddWalletDialog: React.FC<AddWalletDialogProps> = ({ open, onClose, initialStep = "create-mnemonic" }) => {
  const { generateMnemonic, createWallet, importWallet, importEncryptedWallet } = useLocalWallet();

  const [step, setStep] = useState<AddWalletStep>(initialStep);
  const [mnemonic, setMnemonic] = useState("");
  const [walletName, setWalletName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [accessMnemonic, setAccessMnemonic] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Import file state - only V2 encrypted backups supported
  const [importedFile, setImportedFile] = useState<{
    name: string;
    encryptedMnemonic: string;
    address: string;
    passwordHash: string;
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

  // Reset to initialStep when dialog opens
  React.useEffect(() => {
    if (open) {
      setStep(initialStep);
    }
  }, [open, initialStep]);

  const resetState = () => {
    setStep(initialStep);
    setMnemonic("");
    setWalletName("");
    setPassword("");
    setConfirmPassword("");
    setAccessMnemonic("");
    setError(null);
    setIsLoading(false);
    setImportedFile(null);
    setIsDragging(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // File handling functions - only V2 encrypted backups in ZIP format supported
  const processFile = async (file: File) => {
    try {
      // Check if the file is a ZIP file
      if (!file.name.endsWith(".zip") && file.type !== "application/zip") {
        setError("Please upload a ZIP file exported from Hippius");
        return;
      }

      // Read ZIP file and extract wallet-backup.json
      const arrayBuffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(arrayBuffer);

      // Look for wallet-backup.json in the ZIP
      const jsonFile = zip.file("wallet-backup.json");
      if (!jsonFile) {
        setError("Invalid wallet backup ZIP - missing wallet-backup.json");
        return;
      }

      const text = await jsonFile.async("string");
      const data = JSON.parse(text);

      // Only accept version 2 format (encrypted backup with address and passwordHash)
      if (data.version === 2 && data.encryptedMnemonic && data.passwordHash && data.address) {
        setImportedFile({
          name: data.name || "Imported Wallet",
          encryptedMnemonic: data.encryptedMnemonic,
          address: data.address,
          passwordHash: data.passwordHash,
        });
        setWalletName(data.name || "Imported Wallet");
        setError(null);
      } else if (data.encryptedMnemonic && !data.address) {
        // Older format without address - not supported
        setError("This backup file format is outdated. Please export a new backup from your wallet.");
      } else if (data.mnemonic) {
        // Plain mnemonic backup - not supported
        setError("This backup contains an unencrypted mnemonic. Please use 'Add Existing Wallet' and enter the mnemonic manually.");
      } else {
        setError("Invalid wallet backup file");
      }
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

  const handleProceedToPassword = () => {
    if (!walletName.trim()) {
      setError("Please enter a wallet name");
      return;
    }
    setError(null);
    setStep("create-password");
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
    setStep("access-password");
  };

  const handleCreateWallet = async () => {
    setError(null);

    if (!password) {
      setError("Please enter a password");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsLoading(true);

    try {
      const success = await createWallet(walletName || "New Wallet", mnemonic, password);

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

  // Handle access wallet password creation
  const handleAccessWalletCreate = async () => {
    setError(null);

    if (!password) {
      setError("Please enter a password");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsLoading(true);

    try {
      const success = await importWallet(
        walletName || "My Wallet",
        accessMnemonic.trim(),
        password
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

  // Handle import from file - V2 encrypted backup only
  const handleImportWallet = async () => {
    setError(null);

    if (!importedFile) {
      setError("Please select a backup file");
      return;
    }

    setIsLoading(true);
    try {
      const success = await importEncryptedWallet({
        name: importedFile.name,
        address: importedFile.address,
        encryptedMnemonic: importedFile.encryptedMnemonic,
        passwordHash: importedFile.passwordHash,
      });

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
    <div className="flex flex-col items-center p-4">
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

      <CardButton className="w-full h-12 mb-6" onClick={handleProceedToPassword}>
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
          Already have a mnemonic?{" "}
          <span className="font-semibold text-grey-10">Add Mnemonic</span>
        </button>
        <button
          onClick={() => {
            setStep("import");
            setError(null);
          }}
          className="text-sm text-grey-50 hover:text-grey-30 transition-colors"
        >
          Have a wallet backup file?{" "}
          <span className="font-semibold text-grey-10">Import Backup</span>
        </button>
      </div>
    </div>
  );

  const renderCreatePasswordStep = () => (
    <div className="flex flex-col items-center p-4">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-2">Set Password</h2>
      <p className="text-sm text-grey-60 text-center mb-6">
        Set a password to secure your wallet
      </p>

      <div className="w-full space-y-4 mb-4">
        <PasswordInput
          value={password}
          onChange={(val) => {
            setPassword(val);
            setError(null);
          }}
          label="Password"
          placeholder="Enter your password"
          disabled={isLoading}
        />

        <PasswordInput
          value={confirmPassword}
          onChange={(val) => {
            setConfirmPassword(val);
            setError(null);
          }}
          label="Confirm Password"
          placeholder="Reenter password"
          disabled={isLoading}
          onSubmit={handleCreateWallet}
        />
      </div>

      {/* Security Warning */}
      <div className="w-full mb-4 p-3 bg-warning-95 border border-warning-80 rounded-lg">
        <div className="flex items-start gap-2">
          <AlertTriangle className="size-4 text-warning-50 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-grey-30">
            <p className="font-semibold text-grey-10 mb-1">Remember Your Password</p>
            <p>Your password is <strong>not stored</strong> and cannot be recovered. It encrypts your mnemonic and is required to sign transactions.</p>
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

  // Access Wallet Step - Enter existing mnemonic
  const renderAccessWalletStep = () => (
    <div className="flex flex-col items-center p-4">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-2">Add Existing Wallet</h2>
      <p className="text-sm text-grey-60 text-center mb-6">
        Enter your existing mnemonic phrase to add your wallet
      </p>

      {/* Mnemonic Input */}
      <div className="w-full mb-6">
        <label className="text-sm font-medium text-grey-70 mb-2 block">
          Mnemonic
        </label>
        <div className="relative">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-grey-50">
            <Icons.Key className="size-5" />
          </div>
          <Input
            type="password"
            value={accessMnemonic}
            onChange={(e) => {
              setAccessMnemonic(e.target.value);
              setError(null);
            }}
            placeholder="Enter your mnemonic phrase"
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
          Don&apos;t have a mnemonic?{" "}
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
          Have a wallet backup file?{" "}
          <span className="font-semibold text-grey-10">Import Backup</span>
        </button>
      </div>
    </div>
  );

  // Access Password Step - Set password for accessed wallet
  const renderAccessPasswordStep = () => (
    <div className="flex flex-col items-center p-4">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-2">Set Password</h2>
      <p className="text-sm text-grey-60 text-center mb-6">
        Set a password to secure your wallet
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

      <div className="w-full space-y-4 mb-4">
        <PasswordInput
          value={password}
          onChange={(val) => {
            setPassword(val);
            setError(null);
          }}
          label="Password"
          placeholder="Enter your password"
          disabled={isLoading}
        />

        <PasswordInput
          value={confirmPassword}
          onChange={(val) => {
            setConfirmPassword(val);
            setError(null);
          }}
          label="Confirm Password"
          placeholder="Reenter password"
          disabled={isLoading}
          onSubmit={handleAccessWalletCreate}
        />
      </div>

      {/* Security Warning */}
      <div className="w-full mb-4 p-3 bg-warning-95 border border-warning-80 rounded-lg">
        <div className="flex items-start gap-2">
          <AlertTriangle className="size-4 text-warning-50 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-grey-30">
            <p className="font-semibold text-grey-10 mb-1">Remember Your Password</p>
            <p>Your password is <strong>not stored</strong> and cannot be recovered. It encrypts your mnemonic and is required to sign transactions.</p>
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

  // Import Step - V2 encrypted backup only (no password needed)
  const renderImportStep = () => (
    <div className="flex flex-col items-center p-4">
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
              // Only set isDragging to false if leaving the container completely
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setIsDragging(false);
              }
            }}
          >
            <div className="mb-2 pointer-events-none">
              <AbstractIconWrapper className="size-8">
                <BoxSimple className="size-5 text-primary-50 absolute" />
              </AbstractIconWrapper>
            </div>
            <div className="text-sm font-medium text-grey-10 pointer-events-none">
              Upload Backup File
            </div>
            <div className="text-grey-60 text-xs pointer-events-none">
              Drag & drop or click to select (.zip)
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
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
                <p className="text-xs text-grey-50">
                  {importedFile.address.slice(0, 8) + "..." + importedFile.address.slice(-8)}
                </p>
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

      {/* Info box */}
      <div className="w-full bg-primary-50/5 border border-primary-50/20 rounded-lg p-4 mb-4">
        <div className="flex items-start gap-3">
          <Icons.InfoCircle className="size-5 text-primary-50 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-grey-40">
            <p>
              Your wallet will be imported with its original encryption.
              You&apos;ll need your original password when signing transactions (sending balance, staking, etc.).
            </p>
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

      <CardButton
        className="w-full h-12 mb-6"
        onClick={handleImportWallet}
        disabled={isLoading || !importedFile}
        loading={isLoading}
      >
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          {isLoading ? "Importing..." : "Import Wallet"}
          {!isLoading && <ArrowRight className="size-5" />}
        </div>
      </CardButton>

      {/* Bottom options - only show when not opened directly as import */}
      {initialStep !== "import" && (
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={() => {
              setStep("create-mnemonic");
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
              setImportedFile(null);
              setError(null);
            }}
            className="text-sm text-grey-50 hover:text-grey-30 transition-colors"
            disabled={isLoading}
          >
            Already have a mnemonic?{" "}
            <span className="font-semibold text-grey-10">Add Mnemonic</span>
          </button>
        </div>
      )}
    </div>
  );

  const renderStep = () => {
    switch (step) {
      case "create-mnemonic":
        return renderCreateMnemonicStep();
      case "create-password":
        return renderCreatePasswordStep();
      case "access-wallet":
        return renderAccessWalletStep();
      case "access-password":
        return renderAccessPasswordStep();
      case "import":
        return renderImportStep();
      default:
        return renderCreateMnemonicStep();
    }
  };

  const handleBack = () => {
    if (step === "create-password") {
      setStep("create-mnemonic");
    } else if (step === "access-password") {
      setStep("access-wallet");
    } else if (step === "import" || step === "access-wallet") {
      // Reset and go back to create mnemonic
      setAccessMnemonic("");
      setPassword("");
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

        {/* Back Button - hide when opened directly at initialStep (not navigated to) */}
        {step !== "create-mnemonic" && step !== initialStep && (
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

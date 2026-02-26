"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { CardButton, Icons, Input, Graphsheet, AbstractIconWrapper } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";
import { ArrowRight, AlertTriangle, Copy, AlertCircle, X } from "lucide-react";
import { BoxSimple } from "@/components/ui/icons/BoxSimple";
import PasswordInput from "./PasswordInput";
import { cn } from "@/app/lib/utils";
import JSZip from "jszip";

type SetupStep = 
  | "create-mnemonic"
  | "create-password"
  | "access-wallet"
  | "access-password"
  | "import";

interface ImportedFile {
  name: string;
  encryptedMnemonic: string;
  address: string;
  passwordHash: string;
}

/**
 * Initial wallet setup component with unified design
 * Matches the design of AddWalletDialog for consistency
 */
const InitialWalletSetup: React.FC = () => {
  const {
    generateMnemonic,
    createWallet,
    importWallet,
    importEncryptedWallet,
  } = useLocalWallet();

  const [step, setStep] = useState<SetupStep>("create-mnemonic");
  const [mnemonic, setMnemonic] = useState<string>("");
  const [walletName, setWalletName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [accessMnemonic, setAccessMnemonic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Import state
  const [importedFile, setImportedFile] = useState<ImportedFile | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Generate mnemonic on mount
  useEffect(() => {
    if (!mnemonic) {
      const newMnemonic = generateMnemonic();
      setMnemonic(newMnemonic);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(mnemonic);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleNext = () => {
    if (!walletName.trim()) {
      setError("Please enter a wallet name");
      return;
    }
    setError(null);
    setStep("create-password");
  };

  const handleCreateWallet = async () => {
    if (!password) {
      setError("Please enter a password");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const success = await createWallet(walletName.trim() || "New Wallet", mnemonic, password);
      if (!success) {
        setError("Failed to create wallet. This wallet may already exist.");
      }
    } catch (err: unknown) {
      console.error("Failed to create wallet:", err);
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to create wallet");
      }
    } finally {
      setIsLoading(false);
    }
  };

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

  const handleAccessWalletCreate = async () => {
    if (!walletName.trim()) {
      setError("Please enter a wallet name");
      return;
    }
    if (!password) {
      setError("Please enter a password");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const success = await importWallet(walletName.trim() || "My Wallet", accessMnemonic.trim(), password);
      if (!success) {
        setError("Failed to access wallet. This wallet may already exist.");
      }
    } catch (err: unknown) {
      console.error("Failed to access wallet:", err);
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to access wallet");
      }
    } finally {
      setIsLoading(false);
    }
  };

  // File handling functions - only V2 encrypted backups in ZIP format supported
  const processFile = useCallback(async (file: File) => {
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
  }, []);

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      processFile(file);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const clearFile = () => {
    setImportedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleImportWallet = async () => {
    if (!importedFile) return;

    setIsLoading(true);
    setError(null);

    try {
      const success = await importEncryptedWallet({
        name: importedFile.name,
        address: importedFile.address,
        encryptedMnemonic: importedFile.encryptedMnemonic,
        passwordHash: importedFile.passwordHash,
      });

      if (!success) {
        setError("Failed to import wallet. This wallet may already exist.");
      }
    } catch (err: unknown) {
      console.error("Failed to import wallet:", err);
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to import wallet");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleBack = () => {
    if (step === "create-password") {
      setStep("create-mnemonic");
    } else if (step === "access-password") {
      setStep("access-wallet");
    } else if (step === "import" || step === "access-wallet") {
      setAccessMnemonic("");
      setPassword("");
      setWalletName("");
      setImportedFile(null);
      setStep("create-mnemonic");
    }
    setError(null);
  };

  // Render logo consistently
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

  // Create Mnemonic Step
  const renderCreateMnemonicStep = () => (
    <div className="flex flex-col items-center p-4">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-2">Create New Wallet</h2>
      <p className="text-sm text-grey-60 text-center mb-6">
        Your mnemonic is your master key. Save it securely!
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
          />
        </div>
      </div>

      {/* Mnemonic Display */}
      <div className="w-full mb-4">
        <label className="text-sm font-medium text-grey-70 mb-2 block">
          Your Mnemonic
        </label>
        <div className="relative">
          <div className="absolute left-4 top-4 text-grey-50">
            <Icons.Key className="size-5" />
          </div>
          <div className="w-full min-h-[80px] pl-12 pr-12 py-3 border border-grey-80 rounded-lg bg-grey-98 text-grey-10 text-sm font-mono leading-relaxed">
            {mnemonic}
          </div>
          <button
            onClick={handleCopy}
            className="absolute right-3 top-3 p-2 text-grey-50 hover:text-grey-30 transition-colors bg-white rounded-md border border-grey-80"
          >
            {copied ? (
              <Icons.TickCircle className="size-4 text-primary-50" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
        </div>
      </div>

      {/* Important Warning */}
      <div className="w-full mb-4 p-3 bg-warning-95 border border-warning-80 rounded-lg">
        <div className="flex items-start gap-2">
          <AlertTriangle className="size-4 text-warning-50 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-grey-30">
            <p className="font-semibold text-grey-10 mb-1">IMPORTANT</p>
            <ul className="list-disc ml-4 space-y-0.5">
              <li>Write down your mnemonic and keep it safe</li>
              <li>Never share it with anyone</li>
              <li>If you lose it, you lose access to your wallet</li>
            </ul>
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

      <CardButton className="w-full h-12 mb-6" onClick={handleNext}>
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          Next
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
          <span className="font-semibold text-grey-10">Add Existing Wallet</span>
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

  // Create Password Step
  const renderCreatePasswordStep = () => (
    <div className="flex flex-col items-center p-4">
      {renderLogo()}

      <h2 className="text-2xl font-medium text-grey-10 mb-2">Set Password</h2>
      <p className="text-sm text-grey-60 text-center mb-6">
        Create a secure password to encrypt your wallet
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

  // Import Step - V2 encrypted backup
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
                <p className="text-xs text-grey-50 font-mono">
                  {importedFile.address.slice(0, 8)}...{importedFile.address.slice(-8)}
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

      {/* Bottom options */}
      <div className="flex flex-col items-center gap-2">
        <button
          onClick={() => {
            setStep("create-mnemonic");
            setImportedFile(null);
            setError(null);
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

  return (
    <div className="w-[430px] relative">
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
    </div>
  );
};

export default InitialWalletSetup;

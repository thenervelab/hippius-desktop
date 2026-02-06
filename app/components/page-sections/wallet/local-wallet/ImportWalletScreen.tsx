"use client";

import React, { useState, useCallback } from "react";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import PasscodeInput from "./PasscodeInput";
import { ArrowRight, AlertCircle, Upload, FileText, X } from "lucide-react";
import { toast } from "sonner";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";
import { decryptMnemonic } from "@/app/lib/helpers/crypto";

/**
 * Screen for importing an existing wallet
 */
const ImportWalletScreen: React.FC = () => {
  const { importWallet, setSetupStep } = useLocalWallet();
  const [importMethod, setImportMethod] = useState<"file" | "mnemonic">("file");
  const [mnemonic, setMnemonic] = useState("");
  const [passcode, setPasscode] = useState("");
  const [walletName, setWalletName] = useState("");
  const [importedFile, setImportedFile] = useState<{
    name: string;
    encryptedMnemonic: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleFileDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) {
        await processFile(file);
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

  const handleImport = async () => {
    setError(null);

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
      let mnemonicToImport = mnemonic;

      // If importing from file, decrypt with provided passcode
      if (importMethod === "file" && importedFile) {
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
      } else {
        // Importing with mnemonic directly
        if (!isMnemonicValid(mnemonicToImport)) {
          setError("Invalid mnemonic phrase");
          setIsLoading(false);
          return;
        }
      }

      const name = walletName || "Imported Wallet";
      const success = await importWallet(name, mnemonicToImport, passcode);

      if (success) {
        toast.success("Wallet imported successfully!");
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

  const handleCreateNew = () => {
    setSetupStep("create-mnemonic");
  };

  const handleAccessExisting = () => {
    setSetupStep("welcome");
  };

  const clearFile = () => {
    setImportedFile(null);
    setWalletName("");
  };

  return (
    <div className="flex flex-col items-center w-full max-w-[428px] mx-auto px-4 pt-16 pb-8">
      {/* Logo */}
      <div className="mb-8">
        <Icons.HippiusLogo className="size-16" />
      </div>

      {/* Title */}
      <h1 className="text-2xl font-semibold text-grey-10 mb-8">
        Import Wallet
      </h1>

      {/* Import Method Toggle */}
      <div className="w-full flex gap-2 mb-6 p-1 bg-grey-95 rounded-lg">
        <button
          onClick={() => setImportMethod("file")}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${importMethod === "file"
              ? "bg-white text-grey-10 shadow-sm"
              : "text-grey-50 hover:text-grey-30"
            }`}
        >
          From File
        </button>
        <button
          onClick={() => setImportMethod("mnemonic")}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${importMethod === "mnemonic"
              ? "bg-white text-grey-10 shadow-sm"
              : "text-grey-50 hover:text-grey-30"
            }`}
        >
          From Mnemonic
        </button>
      </div>

      {importMethod === "file" ? (
        <>
          {/* File Drop Zone */}
          {!importedFile ? (
            <div
              onDrop={handleFileDrop}
              onDragOver={(e) => e.preventDefault()}
              className="w-full mb-6"
            >
              <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-dashed border-grey-80 rounded-lg cursor-pointer hover:border-primary-50 transition-colors bg-grey-98">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <AbstractIconWrapper className="size-12 text-primary-40 mb-3">
                    <Upload className="absolute size-6 text-primary-50" />
                  </AbstractIconWrapper>
                  <p className="mb-2 text-sm font-medium text-grey-10">
                    Upload a File Here
                  </p>
                  <p className="text-xs text-grey-50">
                    Drag and drop or click to add one or more files here to upload
                  </p>
                </div>
                <input
                  type="file"
                  className="hidden"
                  accept=".json"
                  onChange={handleFileSelect}
                />
              </label>
            </div>
          ) : (
            <div className="w-full mb-6 p-4 bg-grey-98 border border-grey-80 rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileText className="size-5 text-primary-50" />
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
        </>
      ) : (
        <>
          {/* Mnemonic Input */}
          <div className="w-full mb-4">
            <label className="text-sm font-medium text-grey-60 mb-2 block">
              Mnemonic Phrase
            </label>
            <textarea
              value={mnemonic}
              onChange={(e) => {
                setMnemonic(e.target.value);
                setError(null);
              }}
              placeholder="Enter your 12 or 24 word mnemonic phrase"
              className="w-full h-24 px-4 py-3 border border-grey-80 rounded-lg bg-transparent text-grey-10 text-base placeholder:text-grey-60 outline-none transition-all duration-300 hover:shadow-input-focus focus:shadow-input-focus resize-none"
              disabled={isLoading}
            />
          </div>

          {/* Wallet Name Input */}
          <div className="w-full mb-4">
            <label className="text-sm font-medium text-grey-60 mb-2 block">
              Wallet Name
            </label>
            <div className="relative">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-grey-50">
                <Icons.UserSquare className="size-5" />
              </div>
              <input
                type="text"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="Choose a name for your wallet"
                className="w-full h-14 pl-12 pr-4 border border-grey-80 rounded-lg bg-transparent text-grey-10 text-base placeholder:text-grey-60 outline-none transition-all duration-300 hover:shadow-input-focus focus:shadow-input-focus"
                disabled={isLoading}
              />
            </div>
          </div>
        </>
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
          placeholder="Enter your passcode"
          disabled={isLoading}
          onSubmit={handleImport}
        />
        <p className="text-xs text-grey-50 mt-2">
          {importMethod === "file"
            ? "Enter the passcode used when exporting this wallet"
            : "Set a new passcode to secure your imported wallet"}
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Import Button */}
      <CardButton
        className="w-full h-12 mb-6"
        onClick={handleImport}
        disabled={
          isLoading ||
          !passcode ||
          (importMethod === "file" && !importedFile) ||
          (importMethod === "mnemonic" && !mnemonic)
        }
        loading={isLoading}
      >
        <div className="flex items-center justify-center gap-2 text-lg font-medium">
          {isLoading ? "Importing..." : "Import Wallet"}
          {!isLoading && <ArrowRight className="size-5" />}
        </div>
      </CardButton>

      {/* Other Options */}
      <div className="w-full space-y-4 text-center">
        <button
          onClick={handleCreateNew}
          className="text-base text-grey-50 hover:text-grey-30 transition-colors"
          disabled={isLoading}
        >
          Don&apos;t have a wallet?{" "}
          <span className="font-semibold text-grey-10">Create New Wallet</span>
        </button>

        <button
          onClick={handleAccessExisting}
          className="text-base text-grey-50 hover:text-grey-30 transition-colors block w-full"
          disabled={isLoading}
        >
          Have an existing wallet?{" "}
          <span className="font-semibold text-grey-10">Import Your Wallet</span>
        </button>
      </div>
    </div>
  );
};

export default ImportWalletScreen;

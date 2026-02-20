"use client";

import React, { useState, useCallback, useRef } from "react";
import { AbstractIconWrapper, CardButton, Icons, Graphsheet } from "@/components/ui";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import PasswordInput from "./PasswordInput";
import { ArrowRight, AlertCircle, Upload, FileText, X } from "lucide-react";
import { toast } from "sonner";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";
import { decryptMnemonic } from "@/app/lib/helpers/crypto";
import JSZip from "jszip";

/**
 * Screen for importing an existing wallet from file
 */
const ImportWalletScreen: React.FC = () => {
  const { importWallet, setSetupStep } = useLocalWallet();
  const [password, setPassword] = useState("");
  const [importedFile, setImportedFile] = useState<{
    name: string;
    encryptedMnemonic: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const handleFileDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) {
        await processFile(file);
      }
    },
    []
  );

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

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
      // Check if the file is a ZIP file
      if (file.name.endsWith(".zip") || file.type === "application/zip") {
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

        if (!data.encryptedMnemonic) {
          setError("Invalid wallet backup file");
          return;
        }

        setImportedFile({
          name: data.name || "Imported Wallet",
          encryptedMnemonic: data.encryptedMnemonic,
        });
        setError(null);
      } else {
        setError("Please upload a ZIP file exported from Hippius");
      }
    } catch {
      setError("Failed to read wallet backup file");
    }
  };

  const handleImport = async () => {
    setError(null);

    if (!importedFile) {
      setError("Please upload a wallet backup file");
      return;
    }

    if (!password) {
      setError("Please enter a password");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setIsLoading(true);

    try {
      // Decrypt with provided password
      let mnemonicToImport: string;
      try {
        mnemonicToImport = decryptMnemonic(
          importedFile.encryptedMnemonic,
          password
        );
        if (!isMnemonicValid(mnemonicToImport)) {
          setError("Incorrect password for this wallet backup");
          setIsLoading(false);
          return;
        }
      } catch {
        setError("Incorrect password for this wallet backup");
        setIsLoading(false);
        return;
      }

      const name = importedFile.name || "Imported Wallet";
      const success = await importWallet(name, mnemonicToImport, password);

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
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col items-center w-full max-w-[430px] mx-auto px-4 pt-16 pb-8">
      {/* Logo with Graphsheet background */}
      <div className="relative flex items-center justify-center mb-8 size-[100px]">
        <Graphsheet className="absolute inset-0 size-full rounded-full border border-grey-90" />
        <Icons.SplashHippiusLogo className="size-14 z-10" />
      </div>

      {/* Title */}
      <h1 className="text-2xl font-semibold text-grey-10 mb-2">
        Import Your Wallet
      </h1>
      <p className="text-base text-grey-60 text-center mb-8">
        Import your wallet from a backup file
      </p>

      {/* File Drop Zone */}
      {!importedFile ? (
        <div
          onDrop={handleFileDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          className="w-full mb-6"
        >
          <label
            className={`flex flex-col items-center justify-center w-full h-40 border-2 border-dashed rounded-lg cursor-pointer transition-colors bg-grey-98 ${isDragging
              ? "border-primary-50 bg-primary-95"
              : "border-grey-80 hover:border-primary-50"
              }`}
          >
            <div className="flex flex-col items-center justify-center pt-5 pb-6 pointer-events-none">
              <AbstractIconWrapper className="size-12 text-primary-40 mb-3">
                <Upload className="absolute size-6 text-primary-50" />
              </AbstractIconWrapper>
              <p className="mb-2 text-sm font-medium text-grey-10">
                Upload Backup File
              </p>
              <p className="text-xs text-grey-50">
                Drag and drop or click to select (.zip)
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".zip"
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

      {/* Password Input */}
      <div className="w-full mb-6">
        <PasswordInput
          value={password}
          onChange={(val) => {
            setPassword(val);
            setError(null);
          }}
          label="Password"
          placeholder="Enter your password"
          disabled={isLoading}
          onSubmit={handleImport}
        />
        <p className="text-xs text-grey-50 mt-2">
          Enter the password used when exporting this wallet
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
        disabled={isLoading || !password || !importedFile}
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
          Already have a wallet?{" "}
          <span className="font-semibold text-grey-10">Access Wallet</span>
        </button>
      </div>
    </div>
  );
};

export default ImportWalletScreen;

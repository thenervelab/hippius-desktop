/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useState, useCallback, useEffect } from "react";
import { Keyring } from "@polkadot/keyring";
import APIKeysTable from "./APIKeysTable";
import ApiKeyModal from "./ApiKeyModal";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { toast } from "sonner";
import { PlusCircle, RefreshCw, AlertCircle } from "lucide-react";
import GenerateNewAccountModal from "./GenerateNewAccountModal";

import { ConfirmModal, Icons, RevealTextLine } from "@/app/components/ui";
import { useApiKeys } from "@/app/lib/hooks/api/useApiKeys";
import SectionHeader from "@/components/page-sections/settings/SectionHeader";
import {
  saveApiKeySeed,
  hasApiKeySeed,
  deleteApiKeySeed,
} from "@/app/lib/helpers/apiKeySeedsDb";
import { getWalletRecord } from "@/app/lib/helpers/hippiusDesktopDB";
import { hashPasscode } from "@/app/lib/helpers/crypto";
import SeedPasscodeModal from "./SeedPasscodeModal";
import { generateMnemonic } from "@/app/lib/helpers/mnemonic";
import { InView } from "react-intersection-observer";

import { invoke } from "@tauri-apps/api/core";

type BackendSubAccountTuple = [string, string]; // [accountId, address]

const SubAccounts: React.FC = () => {
  const { subs, loading: tableLoading, reload } = useApiKeys();
  const { api, isConnected } = usePolkadotApi();
  const { walletManager } = useWalletAuth();
  const main = walletManager?.polkadotPair.address;

  // form + draft state
  const [formOpen, setFormOpen] = useState(false);
  const [draftAddress, setDraftAddress] = useState("");
  const [draftRole, setDraftRole] = useState<"Upload" | "UploadDelete">(
    "Upload"
  );
  const [openNewAccountModal, setOpenNewAccountModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [generatedMnemonic, setGeneratedMnemonic] = useState("");
  const [error, setError] = useState("");
  const [generatingKey, setGeneratingKey] = useState(false);

  // Backend sub accounts state
  const [fetchingBackendData, setFetchingBackendData] = useState(false);
  const [disabledAccounts, setDisabledAccounts] = useState<Set<string>>(new Set());

  // For direct seed saving (when generated from New Account)
  const [isPasscodeModalOpen, setIsPasscodeModalOpen] = useState(false);
  const [seedToSave, setSeedToSave] = useState("");
  const [addressForSeed, setAddressForSeed] = useState("");

  // For manual seed entry (when created directly)
  const [isSeedEntryModalOpen, setIsSeedEntryModalOpen] = useState(false);
  const [isFromDirectCreation, setIsFromDirectCreation] = useState(false);

  // Track api-keys with seeds
  const [accountsWithSeeds, setAccountsWithSeeds] = useState<Set<string>>(
    new Set()
  );

  // confirm modal state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState<{
    tx: any;
    successMsg: string;
    title: string;
    description: string;
  } | null>(null);
  const [txLoading, setTxLoading] = useState(false);

  // Fetch backend api key details
  const fetchBackendApiKeys = useCallback(async () => {
    setFetchingBackendData(true);
    try {
      const response = await invoke<BackendSubAccountTuple[]>('get_all_subaccount_addresses');
      console.log("Backend api key details:", response);

      if (Array.isArray(response)) {

        const backendAddresses = new Set<string>(
          response.map(([, address]) => address)
        );

        setDisabledAccounts(backendAddresses);
        console.log("Disabled accounts:", [...backendAddresses]);

        console.log("Backend account mappings:",
          response.map(([accountId, address]) => ({ accountId, address }))
        );
      } else {
        console.error("Unexpected response format from get_all_subaccount_addresses");
        setDisabledAccounts(new Set<string>());
      }
    } catch (error) {
      console.error("Error fetching backend api key details:", error);
      toast.error("Failed to fetch api key details from backend");
      setDisabledAccounts(new Set<string>());
    } finally {
      setFetchingBackendData(false);
    }
  }, []);

  // Load the list of accounts with seeds
  const loadAccountsWithSeeds = useCallback(async () => {
    try {
      const addresses = await Promise.all(
        subs.map(async (sub) => {
          const hasSeed = await hasApiKeySeed(sub.address);
          return hasSeed ? sub.address : null;
        })
      );

      setAccountsWithSeeds(
        new Set(addresses.filter((addr): addr is string => addr !== null))
      );
    } catch (error) {
      console.error("Failed to load accounts with seeds:", error);
    }
  }, [subs]);

  useEffect(() => {
    loadAccountsWithSeeds();
  }, [loadAccountsWithSeeds, subs]);

  // Fetch backend data when the component mounts
  useEffect(() => {
    fetchBackendApiKeys();
  }, [fetchBackendApiKeys]);

  // Check if an account is disabled
  const isAccountDisabled = useCallback((address: string) => {
    return disabledAccounts.has(address);
  }, [disabledAccounts]);

  const queueTx = useCallback(
    (tx: any, successMsg: string, title: string, desc: string) => {
      setPending({ tx, successMsg, title, description: desc });
      setConfirmOpen(true);
    },
    []
  );

  const sendQueued = useCallback(async () => {
    if (!pending || !api || !isConnected || !walletManager?.polkadotPair)
      return;
    setTxLoading(true);

    try {
      const unsub = await pending.tx.signAndSend(
        walletManager.polkadotPair,
        { nonce: -1 },
        ({ status, dispatchError }: { status: any; dispatchError: any }) => {
          if (dispatchError) {
            toast.error(dispatchError.toString());
            unsub();
            setTxLoading(false);
            setConfirmOpen(false);
            return;
          }
          if (status.isInBlock || status.isFinalized) {
            toast.success(pending.successMsg);
            unsub();
            setTxLoading(false);
            setConfirmOpen(false);

            if (pending.title === "Add API Key") {
              if (generatedMnemonic && !isFromDirectCreation) {
                // For generated accounts - just ask for passcode
                setSeedToSave(generatedMnemonic);
                setAddressForSeed(draftAddress);
                setIsPasscodeModalOpen(true);
              } else {
                // For direct account creation - ask for seed and passcode
                setAddressForSeed(draftAddress);
                setIsSeedEntryModalOpen(true);
              }
            }

            // Clear draft data
            setDraftAddress("");
            setDraftRole("Upload");
            reload();
          }
        }
      );
    } catch (err) {
      toast.error("Transaction error " + String(err));
      setTxLoading(false);
      setConfirmOpen(false);
    }
  }, [
    pending,
    api,
    isConnected,
    walletManager,
    reload,
    generatedMnemonic,
    draftAddress,
    isFromDirectCreation,
  ]);

  const handlePasscodeSubmit = useCallback(
    async ({ passcode }: { seed?: string; passcode: string }) => {
      try {
        const walletRecord = await getWalletRecord();
        if (!walletRecord) throw new Error("No wallet record found");

        if (hashPasscode(passcode) !== walletRecord.passcodeHash) {
          return { success: false, error: "Incorrect passcode" };
        }

        await saveApiKeySeed(addressForSeed, seedToSave, passcode);
        setAccountsWithSeeds((prev) => new Set([...prev, addressForSeed]));

        return { success: true };
      } catch (error) {
        console.error("Failed to save seed:", error);
        return { success: false, error: "Failed to save seed" };
      }
    },
    [seedToSave, addressForSeed]
  );

  const handleSeedAndPasscodeSubmit = useCallback(
    async ({ seed, passcode }: { seed?: string; passcode: string }) => {
      try {
        if (!seed) {
          return { success: false, error: "Seed phrase is required" };
        }

        const walletRecord = await getWalletRecord();
        if (!walletRecord) throw new Error("No wallet record found");

        if (hashPasscode(passcode) !== walletRecord.passcodeHash) {
          return { success: false, error: "Incorrect passcode" };
        }

        await saveApiKeySeed(addressForSeed, seed, passcode);
        setAccountsWithSeeds((prev) => new Set([...prev, addressForSeed]));

        return { success: true };
      } catch (error) {
        console.error("Failed to save seed:", error);
        return { success: false, error: "Failed to save seed" };
      }
    },
    [addressForSeed]
  );

  const onCreate = useCallback(() => {
    if (!draftAddress.trim()) {
      toast.error("Address is required");
      return;
    }
    setFormOpen(false);

    const tx = api?.tx.subAccount.addSubAccount(
      main!,
      draftAddress,
      draftRole.toLowerCase()
    );

    queueTx(tx, "API key added", "Add API Key", draftAddress);
  }, [api, main, draftAddress, draftRole, queueTx]);

  const onDelete = useCallback(
    async (addr: string) => {
      if (accountsWithSeeds.has(addr)) {
        try {
          await deleteApiKeySeed(addr);
          setAccountsWithSeeds((prev) => {
            const updated = new Set(prev);
            updated.delete(addr);
            return updated;
          });
        } catch (error) {
          console.error("Failed to delete seed:", error);
        }
      }

      const tx = api?.tx.subAccount.removeSubAccount(main!, addr);
      queueTx(
        tx,
        "API key removed",
        "Delete API Key",
        "Are you sure you want to delete this API key? This action is permanent"
      );
    },
    [api, main, queueTx, accountsWithSeeds]
  );

  const handleSeedUpdated = useCallback(() => {
    loadAccountsWithSeeds();
  }, [loadAccountsWithSeeds]);

  const checkHasSeed = useCallback(
    (address: string) => {
      return accountsWithSeeds.has(address);
    },
    [accountsWithSeeds]
  );

  const handleGenerateWallet = async () => {
    setError("");
    setGeneratingKey(true);
    try {
      const newMnemonic = await generateMnemonic();
      setGeneratedMnemonic(newMnemonic);
      setOpenNewAccountModal(true);
      setIsFromDirectCreation(false);
    } catch (error) {
      console.error("Failed to generate access key:", error);
      setError("Failed to generate access key");
    } finally {
      setGeneratingKey(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(generatedMnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Copied to clipboard successfully!");
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleAddAsApiKey = useCallback(async () => {
    try {
      const keyring = new Keyring({ type: "sr25519" });
      const polkadotPair = keyring.addFromMnemonic(generatedMnemonic);
      const address = polkadotPair.address;

      setOpenNewAccountModal(false);
      setDraftAddress(address);
      setSeedToSave(generatedMnemonic);
      setAddressForSeed(address);
      setFormOpen(true);
    } catch (error) {
      console.error("Failed to convert mnemonic to address:", error);
      toast.error("Failed to convert mnemonic to address");
    }
  }, [generatedMnemonic]);

  const handleOpenEmptyApiKeyForm = useCallback(() => {
    setDraftAddress("");
    setDraftRole("Upload");
    setSeedToSave("");
    setAddressForSeed("");
    setIsFromDirectCreation(true);
    setFormOpen(true);
  }, []);

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="w-full space-y-6 border broder-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover"
        >
          <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center flex-wrap gap-2">
            <div className="flex justify-between w-full sm:w-auto">
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-300 w-full"
              >
                <SectionHeader
                  Icon={Icons.KeySquare}
                  title="API Keys"
                  info="API Keys allow you to generate secure credentials for file operations (upload/delete) without sharing your main account access. Each key operates with its own seed while files remain owned by your main account."
                  subtitle="Manage your API keys for secure file operations and delegated access."
                />
              </RevealTextLine>
              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 block sm:hidden ml-auto"
              >
                <button
                  onClick={reload}
                  title="Reload"
                  className="bg-grey-100 hover:bg-grey-90 p-2 text-grey-10 hover:text-grey-20 border border-grey-80 rounded transition"
                >
                  <RefreshCw className="size-4" />
                </button>
              </RevealTextLine>
            </div>
            <div className="w-full sm:w-auto flex items-center justify-end gap-2 sm:gap-4">
              <RevealTextLine
                rotate
                reveal={inView}
                className="delay-300 hidden sm:block"
              >
                <button
                  onClick={reload}
                  title="Reload"
                  className="bg-grey-100 hover:bg-grey-90 p-2 text-grey-10 hover:text-grey-20 border border-grey-80 rounded transition"
                >
                  <RefreshCw className="size-4" />
                </button>
              </RevealTextLine>
              <RevealTextLine rotate reveal={inView} className="delay-300">
                <button
                  onClick={handleGenerateWallet}
                  disabled={generatingKey}
                  className="border border-grey-80 p-2.5 sm:px-3 sm:py-2.5 rounded text-base font-medium bg-grey-100 hover:bg-grey-90 text-grey-10 hover:text-grey-20 transition"
                >
                  Generate New API Key
                </button>
              </RevealTextLine>
              <RevealTextLine rotate reveal={inView} className="delay-300">
                <button
                  onClick={handleOpenEmptyApiKeyForm}
                  className="p-1 bg-primary-50 text-white border border-primary-40 rounded hover:bg-primary-40 transition text-base font-medium"
                >
                  <div className="flex items-center gap-2 px-1 sm:px-2 py-1 border rounded border-primary-40">
                    <PlusCircle className="size-4" />
                    <span>
                      <span className="hidden sm:inline-block">Add</span> API Key
                    </span>
                  </div>
                </button>
              </RevealTextLine>
            </div>
          </div>

          <APIKeysTable
            subs={subs}
            loading={tableLoading || fetchingBackendData}
            onDelete={onDelete}
            hasSeed={checkHasSeed}
            onSeedUpdated={handleSeedUpdated}
            isDisabled={isAccountDisabled}
          />

          <ApiKeyModal
            open={formOpen && !confirmOpen}
            address={draftAddress}
            role={draftRole}
            onAddressChange={setDraftAddress}
            onRoleChange={setDraftRole}
            onClose={() => setFormOpen(false)}
            onSubmit={onCreate}
          />

          {pending && (
            <ConfirmModal
              open={confirmOpen}
              title={pending.title}
              description={
                pending.title === "Add API Key" ? (
                  <div className="space-y-1">
                    <p className="font-medium">
                      You are about to create an API key with the address:
                    </p>
                    <p className="tracking-wide break-all font-bold">
                      {pending.description}
                    </p>
                  </div>
                ) : (
                  pending.description
                )
              }
              loading={txLoading}
              onConfirm={sendQueued}
              onCancel={() => {
                setConfirmOpen(false);
                if (!pending.title.startsWith("Delete")) {
                  setFormOpen(true);
                }
              }}
              variant={pending.title.startsWith("Delete") ? "delete" : "create"}
            />
          )}

          <GenerateNewAccountModal
            open={openNewAccountModal}
            onClose={() => setOpenNewAccountModal(false)}
            copyToClipboard={copyToClipboard}
            generatedMnemonic={generatedMnemonic}
            copied={copied}
            onAddAsApiKey={handleAddAsApiKey}
          />

          <SeedPasscodeModal
            open={isPasscodeModalOpen}
            onClose={() => setIsPasscodeModalOpen(false)}
            onSubmit={handlePasscodeSubmit}
            title="Save API Key Seed"
            description="Enter your passcode to encrypt and save the seed for the newly created API key"
            address={addressForSeed}
            seedInputRequired={false}
            cancelLabel="Skip"
            submitLabel="Save Seed"
          />

          <SeedPasscodeModal
            open={isSeedEntryModalOpen}
            onClose={() => setIsSeedEntryModalOpen(false)}
            onSubmit={handleSeedAndPasscodeSubmit}
            title="Save API Key Seed"
            description="Enter the seed phrase for your API key and your passcode to encrypt it"
            address={addressForSeed}
            seedInputRequired={true}
            cancelLabel="Skip"
            submitLabel="Save Seed"
          />

          {error && (
            <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
              <AlertCircle className="size-4 !relative" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </InView>
  );
};

export default SubAccounts;

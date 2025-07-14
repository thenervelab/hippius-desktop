/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useState, useCallback } from "react";
import { Keyring } from "@polkadot/keyring";
import SubAccountTable from "./SubAccountTable";
import SubAccountModal, { ModalData } from "./SubAccountModal";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { toast } from "sonner";
import { PlusCircle, RefreshCw, AlertCircle } from "lucide-react";
import GenerateNewAccountModal from "./GenerateNewAccountModal";

import { ConfirmModal, Icons } from "@/app/components/ui";
import { useSubAccounts } from "@/app/lib/hooks/api/useSubAccounts";
import { WalletManager } from "@/app/lib/web3/wallet-manager";
import SectionHeader from "../SectionHeader";

const SubAccounts: React.FC = () => {
  const { subs, loading: tableLoading, reload } = useSubAccounts();
  const { api, isConnected } = usePolkadotApi();
  const { walletManager } = useWalletAuth();
  const main = walletManager?.polkadotPair.address;

  // form + draft state
  const [formOpen, setFormOpen] = useState(false);
  const [draftAddress, setDraftAddress] = useState("");
  const [draftRole, setDraftRole] = useState<ModalData["role"]>("Upload");
  const [openNewAccountModal, setOpenNewAccountModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [generatedMnemonic, setGeneratedMnemonic] = useState("");
  const [error, setError] = useState("");
  const [generatingKey, setGeneratingKey] = useState(false);

  // confirm modal state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState<{
    tx: any;
    successMsg: string;
    title: string;
    description: string;
  } | null>(null);
  const [txLoading, setTxLoading] = useState(false);

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
            // clear the draft only on success
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
  }, [pending, api, isConnected, walletManager, reload]);

  const onCreate = useCallback(() => {
    if (!draftAddress.trim()) {
      toast.error("Sub account address is required");
      return;
    }
    setFormOpen(false);
    const tx = api?.tx.subAccount.addSubAccount(
      main!,
      draftAddress,
      draftRole.toLowerCase()
    );
    queueTx(tx, "Sub account added", "Create Sub Account", draftAddress);
  }, [api, main, draftAddress, draftRole, queueTx]);

  const onDelete = useCallback(
    (addr: string) => {
      const tx = api?.tx.subAccount.removeSubAccount(main!, addr);
      queueTx(
        tx,
        "Sub account removed",
        "Delete Sub Account",
        "Are you sure you want to delete this sub account? This action is permanent"
      );
    },
    [api, main, queueTx]
  );

  const handleGenerateWallet = async () => {
    setError("");
    setGeneratingKey(true);
    try {
      const newMnemonic = await WalletManager.generateMnemonic();
      setGeneratedMnemonic(newMnemonic);
      setOpenNewAccountModal(true);
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

  // Add this function to handle the "Add as Sub Account" action
  const handleAddAsSubAccount = useCallback(async () => {
    try {
      // Create Polkadot account
      const keyring = new Keyring({ type: "sr25519" });
      const polkadotPair = keyring.addFromMnemonic(generatedMnemonic);
      const address = polkadotPair.address;

      // Close the new account modal
      setOpenNewAccountModal(false);

      // Set the draft address and open the sub account modal
      setDraftAddress(address);
      setFormOpen(true);
    } catch (error) {
      console.error("Failed to convert mnemonic to address:", error);
      toast.error("Failed to convert mnemonic to address");
    }
  }, [generatedMnemonic]);

  const handleOpenEmptySubAccountForm = useCallback(() => {
    setDraftAddress("");
    setFormOpen(true);
  }, []);

  return (
    <div className="w-full space-y-6 border broder-grey-80 rounded-lg p-4 ">
      {/* header */}
      <div className="flex flex-col sm:flex-row sm:justify-between items-start sm:items-center flex-wrap gap-2">
        <div className="flex justify-between w-full sm:w-auto">
          <SectionHeader
            Icon={Icons.KeySquare}
            title="Sub Accounts"
            subtitle="Manage your sub accounts for delegated access and permissions."
          />
          <button
            onClick={reload}
            title="Reload"
            className="block sm:hidden ml-auto bg-grey-100 hover:bg-grey-90 p-2 text-grey-10 hover:text-grey-20 border border-grey-80 rounded transition"
          >
            <RefreshCw className="size-4" />
          </button>
        </div>
        <div className="w-full sm:w-auto flex items-center justify-end gap-2 sm:gap-4">
          <button
            onClick={reload}
            title="Reload"
            className="hidden sm:block bg-grey-100 hover:bg-grey-90 p-2 text-grey-10 hover:text-grey-20 border border-grey-80 rounded transition"
          >
            <RefreshCw className="size-4" />
          </button>
          <button
            onClick={handleGenerateWallet}
            disabled={generatingKey}
            className="border border-grey-80 p-2.5 sm:px-3 sm:py-2.5 rounded text-base font-medium bg-grey-100 hover:bg-grey-90 text-grey-10 hover:text-grey-20 transition"
          >
            Generate New Account
          </button>
          <button
            onClick={handleOpenEmptySubAccountForm}
            className="p-1 bg-primary-50 text-white border border-primary-40 rounded hover:bg-primary-40 transition text-base font-medium"
          >
            <div className="flex items-center gap-2 px-1 sm:px-2 py-1 border rounded border-primary-40">
              <PlusCircle className="size-4" />
              <span>
                <span className="hidden sm:inline-block">New</span> Sub Account
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* table */}
      <SubAccountTable subs={subs} loading={tableLoading} onDelete={onDelete} />

      {/* sub-account form modal (only when confirm is closed) */}
      <SubAccountModal
        open={formOpen && !confirmOpen}
        address={draftAddress}
        role={draftRole}
        onAddressChange={setDraftAddress}
        onRoleChange={setDraftRole}
        onClose={() => setFormOpen(false)}
        onSubmit={onCreate}
      />

      {/* confirm modal */}
      {pending && (
        <ConfirmModal
          open={confirmOpen}
          title={pending.title}
          description={
            pending.title === "Create Sub Account" ? (
              <div className="space-y-1">
                <p className="font-medium">
                  You are about to create a sub account with the address:
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
            // only go back into form for create flow
            if (!pending.title.startsWith("Delete")) {
              setFormOpen(true);
            }
          }}
          variant={pending.title.startsWith("Delete") ? "delete" : "create"}
        />
      )}

      {/* new account modal*/}
      <GenerateNewAccountModal
        open={openNewAccountModal}
        onClose={() => setOpenNewAccountModal(false)}
        copyToClipboard={copyToClipboard}
        generatedMnemonic={generatedMnemonic}
        copied={copied}
        onAddAsSubAccount={handleAddAsSubAccount}
      />

      {error && (
        <div className="flex text-error-70 text-sm font-medium mt-2 items-center gap-2">
          <AlertCircle className="size-4 !relative" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

export default SubAccounts;

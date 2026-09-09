"use client";

import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { FolderPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Input } from "@/components/ui/input";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { cn } from "@/lib/utils";

/**
 * Create a folder in a Drive folder this device does not sync.
 *
 * A local drive gets a folder by making the directory and letting the
 * engine register it. There is no directory here, so Rust registers the
 * folder entity with the server directly — which is why this is its own
 * control rather than a mode of the local new-folder flow.
 */
const RemoteNewFolderButton: React.FC<{
  label: string;
  parentPath?: string;
  onCreated?: () => void;
  className?: string;
}> = ({ label, parentPath, onCreated, className }) => {
  const { polkadotAddress } = useWalletAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setName("");
  };

  const create = async () => {
    if (!polkadotAddress || busy) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    setBusy(true);
    try {
      await invoke("create_remote_folder", {
        accountId: polkadotAddress,
        label,
        parentPath: parentPath ?? null,
        name: trimmed,
      });
      toast.success(`Created "${trimmed}"`);
      close();
      onCreated?.();
    } catch (err) {
      // Rust validates the name and owns the sentence.
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="defaultStable"
        size="auto"
        onClick={() => setOpen(true)}
        className={cn(
          "h-[30px] gap-2 rounded-[6px] px-3 py-[10px] font-geist text-[14px] leading-[1.109] tracking-[-0.28px]",
          className,
        )}
      >
        <FolderPlus className="size-4" />
        New Folder
      </Button>

      <FramedDialog
        open={open}
        onClose={close}
        title="New Folder"
        icon={<FolderPlus className="size-4 text-white" />}
        maxWidth="max-w-[520px]"
      >
        <div className="flex flex-col gap-4">
          <Input
            autoFocus
            value={name}
            placeholder="Folder name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <div className="flex gap-3">
            <Button
              variant="defaultStable"
              size="auto"
              onClick={close}
              className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="auto"
              loading={busy}
              disabled={!name.trim()}
              onClick={() => void create()}
              className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
            >
              Create
            </Button>
          </div>
        </div>
      </FramedDialog>
    </>
  );
};

export default RemoteNewFolderButton;

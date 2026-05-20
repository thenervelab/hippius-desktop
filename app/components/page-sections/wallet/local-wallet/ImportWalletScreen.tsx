"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Eye, EyeOff, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import {
  Decoration,
  FilePlus,
  HardDriveUpload,
  Key,
  WalletBackupFile,
} from "@/components/ui/icons";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { getDiagonalTextureSvgBackgroundImage } from "@/app/lib/ui-textures";

const cornerTextureLight = getDiagonalTextureSvgBackgroundImage({
  opacity: 0.21,
});
const cornerTextureDark = getDiagonalTextureSvgBackgroundImage({
  color: "white",
  opacity: 0.1,
});

interface ImportWalletScreenProps {
  onImported: () => void;
  onBack: () => void;
}

interface ParsedBackup {
  name: string;
  address: string;
  encryptedMnemonic: string;
  passwordHash: string;
}

// Normalise the snake_case keys Rust uses in `local_wallet_export_backup`
// into the camelCase shape `importEncryptedWallet` expects, falling
// back to camelCase keys if the file was already saved that way.
function parseBackupFile(text: string): ParsedBackup | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = (r.name ?? r["wallet_name"]) as string | undefined;
  const address = r.address as string | undefined;
  const encryptedMnemonic = (r.encryptedMnemonic ??
    r["encrypted_mnemonic"]) as string | undefined;
  const passwordHash = (r.passwordHash ??
    r["password_hash"]) as string | undefined;
  if (
    typeof name !== "string" ||
    typeof address !== "string" ||
    typeof encryptedMnemonic !== "string" ||
    typeof passwordHash !== "string"
  ) {
    return null;
  }
  return { name, address, encryptedMnemonic, passwordHash };
}

const ImportWalletScreen: React.FC<ImportWalletScreenProps> = ({
  onImported,
  onBack,
}) => {
  const { importEncryptedWallet, setSetupStep } = useLocalWallet();
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedBackup | null>(null);
  const [passcode, setPasscode] = useState("");
  const [showPasscode, setShowPasscode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const loadFile = useCallback(async (path: string) => {
    try {
      const text = await readTextFile(path);
      const result = parseBackupFile(text);
      if (!result) {
        setError(
          "Couldn't read that file. Pick a wallet backup exported from Hippius.",
        );
        return;
      }
      setFileName(path.split(/[\\/]/).pop() ?? path);
      setParsed(result);
      setError(null);
    } catch (e) {
      console.error("[ImportWalletScreen] readTextFile failed:", e);
      setError("Couldn't open that file. Check that it's still in place.");
    }
  }, []);

  const handlePick = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Wallet backup", extensions: ["json", "csv"] }],
      });
      if (typeof selected === "string") {
        await loadFile(selected);
      }
    } catch (e) {
      console.error("[ImportWalletScreen] file picker failed:", e);
      toast.error("Failed to open file picker");
    }
  }, [loadFile]);

  const handleClear = useCallback(() => {
    setFileName(null);
    setParsed(null);
    setError(null);
  }, []);

  // Native Tauri drag-drop — same event channel the regular file
  // dropzone uses (`tauri://drag-*`). One file only; extras are
  // silently dropped.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const push = (un: () => void) => {
      if (cancelled) un();
      else unlisteners.push(un);
    };

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;

        push(
          await listen("tauri://drag-enter", () => setIsDragging(true)),
        );
        push(await listen("tauri://drag-over", () => {}));
        push(
          await listen<{ paths: string[] }>(
            "tauri://drag-drop",
            async (event) => {
              setIsDragging(false);
              const first = event.payload.paths?.[0];
              if (first) await loadFile(first);
            },
          ),
        );
        push(
          await listen("tauri://drag-leave", () => setIsDragging(false)),
        );
      } catch (e) {
        console.error(
          "[ImportWalletScreen] Failed to register drag listeners:",
          e,
        );
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, [loadFile]);

  const canSubmit = useMemo(
    () => !!parsed && passcode.length > 0 && !submitting,
    [parsed, passcode, submitting],
  );

  const handleSubmit = async () => {
    if (!parsed || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const ok = await importEncryptedWallet({
        name: parsed.name,
        address: parsed.address,
        encryptedMnemonic: parsed.encryptedMnemonic,
        passwordHash: parsed.passwordHash,
      });
      if (ok) {
        toast.success("Wallet imported");
        onImported();
      } else {
        setError("Failed to import wallet. Check the file and passcode.");
      }
    } catch (e) {
      console.error("[ImportWalletScreen] import failed:", e);
      setError(e instanceof Error ? e.message : "Failed to import wallet");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-1 w-full items-center justify-center px-4 py-6 mt-[14px] overflow-hidden rounded-[8px] border border-[#E3E3E3] dark:border-[#313131] bg-white dark:bg-[#1a1a1a]">
      <div className="relative">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-full bottom-full w-screen h-screen bg-[rgba(242,242,242,0.42)] dark:hidden"
          style={{ backgroundImage: cornerTextureLight }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-full w-screen h-screen bg-[rgba(242,242,242,0.42)] dark:hidden"
          style={{ backgroundImage: cornerTextureLight }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-full bottom-full w-screen h-screen bg-[#1A1A1A] hidden dark:block"
          style={{ backgroundImage: cornerTextureDark }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-full top-full w-screen h-screen bg-[#1A1A1A] hidden dark:block"
          style={{ backgroundImage: cornerTextureDark }}
        />

        <BackgroundContainer
          className="relative w-full max-w-[594px]"
          fillClassName="fill-[#f9f9f9] dark:fill-[#202020]"
          strokeClassName="stroke-[#b3b3b3] dark:stroke-[#6c6c6c]"
          borderClassName="bg-transparent dark:bg-transparent p-0 sm:p-0"
          contentClassName="flex justify-center"
          decorationLineColor="rgba(151, 151, 151, 0.17)"
          shellClassName={cn(
            "w-full min-w-0 max-w-[494px]",
            "bg-white dark:bg-[#1a1a1a]",
            "p-3 sm:p-3 rounded-[8px] sm:rounded-[8px]",
          )}
          cardClassName={cn(
            "w-full min-w-0 max-w-full",
            "p-4 gap-[26px] items-stretch",
            "rounded-[10px] sm:rounded-[10px]",
            "bg-white dark:bg-[#161616]",
            "shadow-[0px_350px_98px_0px_rgba(0,0,0,0),0px_224px_90px_0px_rgba(0,0,0,0.01),0px_126px_76px_0px_rgba(0,0,0,0.03),0px_56px_56px_0px_rgba(0,0,0,0.05),0px_14px_31px_0px_rgba(0,0,0,0.06)]",
          )}
        >
          <div className="flex flex-col items-center gap-[19px]">
            <div className="relative flex items-center justify-center size-[56px] shrink-0">
              <Decoration
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 size-full"
              />
              <div className="relative flex items-center justify-center size-[32px] aspect-square rounded-[8px] bg-primary-50 dark:bg-primary-brand-dark">
                <HardDriveUpload className="size-4 shrink-0 text-white" />
              </div>
            </div>

            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-[24px] font-medium leading-[32px] text-grey-10 dark:text-grey-light-100">
                Import Wallet
              </h1>
              <p className="max-w-[424px] text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-grey-50 dark:text-grey-dark-500">
                Enter your wallet access key to continue or create a new wallet
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2.5">
              <label className="text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-dark-600 dark:text-grey-dark-600">
                Upload File
              </label>

              {fileName ? (
                <div
                  className={cn(
                    "flex flex-col items-center justify-center gap-3 rounded-[8px] border-2 border-dashed py-6",
                    "border-grey-dark-100 bg-white dark:border-black-300 dark:bg-[#1a1a1a]",
                  )}
                >
                  <WalletBackupFile className="h-[94px] w-[78px] shrink-0 drop-shadow-[0_2px_4px_rgba(0,0,0,0.06)]" />
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-medium text-grey-10 dark:text-grey-light-100">
                      {fileName}
                    </span>
                    <button
                      type="button"
                      onClick={handleClear}
                      className="text-grey-50 hover:text-error-70 dark:text-grey-dark-600"
                      aria-label="Remove file"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handlePick}
                  className={cn(
                    "flex flex-col items-center justify-center gap-3 rounded-[8px] border-2 border-dashed py-8 px-4 transition-colors cursor-pointer",
                    "border-grey-dark-100 bg-white hover:bg-grey-light-300",
                    "dark:border-black-300 dark:bg-[#1a1a1a] dark:hover:bg-[#222]",
                    isDragging &&
                      "border-primary-50 bg-primary-50/5 dark:border-primary-brand-dark dark:bg-primary-50/10",
                  )}
                >
                  <span className="flex items-center justify-center size-[32px] aspect-square rounded-[8px] bg-primary-50 dark:bg-primary-brand-dark">
                    <FilePlus className="size-3 shrink-0 text-white" />
                  </span>
                  <div className="flex flex-col items-center gap-1 text-center">
                    <span className="text-[16px] font-medium leading-[22px] tracking-[-0.32px] text-grey-10 dark:text-grey-light-100">
                      Upload a File Here
                    </span>
                    <span className="max-w-[260px] text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-50 dark:text-grey-dark-500">
                      Drag and drop or click to add one or more files here to
                      upload
                    </span>
                  </div>
                </button>
              )}
            </div>

            <div className="flex flex-col gap-2.5">
              <label
                htmlFor="import-passcode"
                className="text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-dark-600 dark:text-grey-dark-600"
              >
                Passcode
              </label>
              <Input
                id="import-passcode"
                value={passcode}
                onChange={(e) => {
                  setPasscode(e.target.value);
                  setError(null);
                }}
                type={showPasscode ? "text" : "password"}
                placeholder="Enter your passcode"
                autoComplete="off"
                startAdornment={<Key className="size-5 sm:size-6" />}
                endAdornment={
                  <button
                    type="button"
                    onClick={() => setShowPasscode((s) => !s)}
                    className="text-grey-50 dark:text-grey-dark-600 hover:text-grey-10 dark:hover:text-grey-light-100"
                    aria-label={showPasscode ? "Hide passcode" : "Show passcode"}
                  >
                    {showPasscode ? (
                      <EyeOff className="size-5" />
                    ) : (
                      <Eye className="size-5" />
                    )}
                  </button>
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
              />
            </div>

            {error ? (
              <p className="text-[12px] font-medium text-error-70">{error}</p>
            ) : null}

            <Button
              type="button"
              variant="primary"
              size="auto"
              className={cn(
                "h-[52px] w-full rounded-[6px] gap-2.5 px-2.5",
                "text-[18px] font-normal tracking-[-0.36px] leading-[1.109]",
                !canSubmit && "!bg-primary-50/40 hover:!bg-primary-50/40",
              )}
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {submitting ? "Importing..." : "Import Wallet"}
              {!submitting ? <ArrowRight className="size-4 shrink-0" /> : null}
            </Button>
          </div>

          <div className="flex flex-col gap-2 text-center">
            <p className="flex items-center justify-center gap-2 text-[18px] leading-6 tracking-[-0.36px]">
              <span className="font-medium text-grey-50 dark:text-grey-dark-500">
                Already have a wallet?
              </span>
              <button
                type="button"
                onClick={onBack}
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark hover:underline underline-offset-2 transition-colors"
              >
                Access Wallet
              </button>
            </p>
            <p className="flex items-center justify-center gap-2 text-[18px] leading-6 tracking-[-0.36px]">
              <span className="font-medium text-grey-50 dark:text-grey-dark-500">
                Don&apos;t have a wallet?
              </span>
              <button
                type="button"
                onClick={() => setSetupStep("create-mnemonic")}
                className="font-semibold text-grey-10 dark:text-grey-light-100 hover:text-primary-50 dark:hover:text-primary-brand-dark hover:underline underline-offset-2 transition-colors"
              >
                Create New Wallet
              </button>
            </p>
          </div>

        </BackgroundContainer>
      </div>
    </div>
  );
};

export default ImportWalletScreen;

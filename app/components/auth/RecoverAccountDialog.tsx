"use client";

/**
 * Recover-an-account flow.
 *
 * For a user who has their backed-up mnemonic but has lost access to their
 * sign-in method. All business logic is in Rust; this component only
 * orchestrates the three IPCs and renders progress:
 *   1. `list_recoverable_accounts(mnemonic)` — which accounts this seed can restore
 *   2. `recover_account_files(mnemonic, ownerAddress, destinationDir)` — pull + decrypt
 *   3. `cancel_account_recovery()` — request an in-flight pull to stop
 * and listens to the `recovery_progress` event for a determinate bar.
 *
 * The mnemonic lives in component state only while the dialog is open and is
 * cleared on close.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button, Icons } from "@/components/ui";

interface RecoverableAccount {
  ownerAddress: string;
  scope: string;
}

interface RecoverySummary {
  folders: number;
  filesRecovered: number;
  filesFailed: number;
  bytes: number;
  errors: string[];
  cancelled: boolean;
}

interface RecoveryProgress {
  filesDone: number;
  filesTotal: number;
  bytes: number;
  label: string;
  file: string;
}

type Step = "input" | "select" | "running" | "done";

function shortAddr(addr: string): string {
  return addr.length > 16 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

export function RecoverAccountDialog({
  open: isOpen,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("input");
  const [mnemonic, setMnemonic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<RecoverableAccount[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [progress, setProgress] = useState<RecoveryProgress | null>(null);
  const [summary, setSummary] = useState<RecoverySummary | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const reset = useCallback(() => {
    setStep("input");
    setMnemonic("");
    setBusy(false);
    setError(null);
    setAccounts([]);
    setSelected(null);
    setDestDir(null);
    setProgress(null);
    setSummary(null);
  }, []);

  // Tear down the progress listener whenever the dialog closes or unmounts so a
  // stale subscription never leaks across opens.
  useEffect(() => {
    if (!isOpen) {
      unlistenRef.current?.();
      unlistenRef.current = null;
      reset();
    }
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [isOpen, reset]);

  const handleFindAccounts = async () => {
    const phrase = mnemonic.trim();
    if (!phrase) {
      setError("Enter your mnemonic seed phrase.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const found = await invoke<RecoverableAccount[]>("list_recoverable_accounts", { mnemonic: phrase });
      if (found.length === 0) {
        setError(
          "This mnemonic isn't registered to recover any account. On a device where you're still signed in, enable recovery in Settings → Recovery first."
        );
        return;
      }
      setAccounts(found);
      setSelected(found[0]?.ownerAddress ?? null);
      setStep("select");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not look up recoverable accounts.");
    } finally {
      setBusy(false);
    }
  };

  const handleChooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false, title: "Choose a folder to restore files into" });
    if (typeof picked === "string") setDestDir(picked);
  };

  const handleRecover = async () => {
    if (!selected || !destDir) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    setStep("running");

    unlistenRef.current?.();
    unlistenRef.current = await listen<RecoveryProgress>("recovery_progress", (e) => setProgress(e.payload));

    try {
      const result = await invoke<RecoverySummary>("recover_account_files", {
        mnemonic: mnemonic.trim(),
        ownerAddress: selected,
        destinationDir: destDir,
      });
      setSummary(result);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery failed.");
      setStep("select");
    } finally {
      setBusy(false);
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  };

  const handleCancel = async () => {
    try {
      await invoke("cancel_account_recovery");
      toast.message("Stopping recovery after the current file…");
    } catch {
      // Best-effort; the pull may already be finishing.
    }
  };

  const pct =
    progress && progress.filesTotal > 0
      ? Math.min(100, Math.round((progress.filesDone / progress.filesTotal) * 100))
      : 0;

  return (
    <FramedDialog
      open={isOpen}
      onClose={onClose}
      title="Recover an Account"
      icon={<Icons.Key className="size-5 text-white" />}
      maxWidth="max-w-[560px]"
    >
      {step === "input" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[#7D7D7D] dark:text-grey-dark-600">
            Paste your backed-up mnemonic seed phrase. We&apos;ll find which account it can restore and download your files to a folder you choose.
          </p>
          <textarea
            value={mnemonic}
            onChange={(e) => setMnemonic(e.target.value)}
            placeholder="Enter or paste your 12-word seed phrase"
            rows={3}
            className="w-full rounded-md border border-grey-80 bg-white p-3 font-mono text-sm text-grey-10 dark:border-[#3a3a3a] dark:bg-[#1a1a1a] dark:text-white"
          />
          {error && <p className="text-sm text-error-50">{error}</p>}
          <Button variant="primary" size="auto" onClick={handleFindAccounts} loading={busy} disabled={busy} className="h-[44px] w-full rounded-[6px]">
            Find My Accounts
          </Button>
        </div>
      )}

      {step === "select" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[#7D7D7D] dark:text-grey-dark-600">Choose the account to recover and where to save its files.</p>
          <div className="flex flex-col gap-2">
            {accounts.map((acc) => (
              <button
                key={acc.ownerAddress}
                type="button"
                onClick={() => setSelected(acc.ownerAddress)}
                className={`flex items-center justify-between rounded-md border p-3 text-left text-sm ${
                  selected === acc.ownerAddress
                    ? "border-[#3167DD] bg-[#3167dd]/5"
                    : "border-grey-80 dark:border-[#3a3a3a]"
                }`}
              >
                <span className="font-mono text-grey-10 dark:text-white">{shortAddr(acc.ownerAddress)}</span>
                <span className="text-xs text-grey-40 dark:text-grey-dark-600">{acc.scope}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="defaultStable" size="auto" onClick={handleChooseFolder} className="h-[40px] rounded-md px-3 text-sm">
              Choose Folder
            </Button>
            <span className="flex-1 truncate rounded-md border border-grey-80 px-3 py-2 text-sm text-grey-40 dark:border-[#3a3a3a] dark:text-grey-dark-600">
              {destDir ?? "No folder selected"}
            </span>
          </div>
          {error && <p className="text-sm text-error-50">{error}</p>}
          <Button
            variant="primary"
            size="auto"
            onClick={handleRecover}
            disabled={!selected || !destDir || busy}
            loading={busy}
            className="h-[44px] w-full rounded-[6px]"
          >
            Recover Files
          </Button>
        </div>
      )}

      {step === "running" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm font-medium text-grey-10 dark:text-white">Recovering your files…</p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-grey-80 dark:bg-[#3a3a3a]">
            <div className="h-full bg-[#3167DD] transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-grey-40 dark:text-grey-dark-600">
            {progress ? `${progress.filesDone} of ${progress.filesTotal} files · ${progress.file}` : "Preparing…"}
          </p>
          <Button variant="defaultStable" size="auto" onClick={handleCancel} className="h-[40px] self-start rounded-md px-3 text-sm">
            Cancel
          </Button>
        </div>
      )}

      {step === "done" && summary && (
        <div className="flex flex-col gap-4">
          <p className="text-sm font-medium text-grey-10 dark:text-white">
            {summary.cancelled ? "Recovery cancelled (partial)" : "Recovery complete"}
          </p>
          <div className="rounded-md border border-grey-80 bg-[#fafafa] p-3 text-sm dark:border-[#3a3a3a] dark:bg-[#2a2a2a]">
            <p className="text-grey-10 dark:text-white">{summary.filesRecovered} files recovered across {summary.folders} folders</p>
            {summary.filesFailed > 0 && <p className="text-error-50">{summary.filesFailed} files could not be recovered</p>}
          </div>
          {summary.errors.length > 0 && (
            <details className="text-xs text-grey-40 dark:text-grey-dark-600">
              <summary className="cursor-pointer">Show {summary.errors.length} issue(s)</summary>
              <ul className="mt-2 list-disc pl-4">
                {summary.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
          <Button variant="primary" size="auto" onClick={onClose} className="h-[44px] w-full rounded-[6px]">
            Done
          </Button>
        </div>
      )}
    </FramedDialog>
  );
}

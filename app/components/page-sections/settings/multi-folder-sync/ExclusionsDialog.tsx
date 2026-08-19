"use client";

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui";
import { Input } from "@/components/ui/input";
import { FolderOpen } from "@/components/ui/icons";

interface ExclusionsDialogProps {
  open: boolean;
  /** Drive label — the key every exclusion IPC is scoped by. */
  label: string | undefined;
  onClose: () => void;
}

/** Message text from a Tauri IPC rejection, whatever shape it arrives in. */
function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const { message } = error as { message?: unknown };
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

/**
 * Per-drive exclusion editor.
 *
 * Presentation only: every rule about what a pattern may be lives in Rust
 * (`sync::selective::validate_pattern`), and this dialog surfaces whatever it
 * refuses. Deliberately no client-side mirror of those rules — a second copy
 * would drift, and the failure mode of a wrong mirror here is either blocking
 * a legal pattern or letting through one that silently stops the drive.
 */
export default function ExclusionsDialog({
  open,
  label,
  onClose,
}: ExclusionsDialogProps) {
  const [patterns, setPatterns] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!label) return;
    setLoading(true);
    try {
      setPatterns(
        await invoke<string[]>("list_exclude_patterns", { label }),
      );
    } catch (error) {
      toast.error(errorMessage(error, "Could not load exclusions"));
    } finally {
      setLoading(false);
    }
  }, [label]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleAdd = async () => {
    const pattern = draft.trim();
    if (!pattern || !label || busy) return;
    setBusy(true);
    try {
      await invoke<boolean>("add_exclude_pattern", { label, pattern });
      // Reflect locally rather than refetching: the add already returned the
      // authoritative outcome, and a round trip would blank the list mid-edit.
      setPatterns((current) =>
        current.includes(pattern) ? current : [...current, pattern],
      );
      setDraft("");
    } catch (error) {
      toast.error(errorMessage(error, "Could not add that pattern"));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (pattern: string) => {
    if (!label || busy) return;
    setBusy(true);
    try {
      await invoke<boolean>("remove_exclude_pattern", { label, pattern });
      setPatterns((current) => current.filter((p) => p !== pattern));
    } catch (error) {
      toast.error(errorMessage(error, "Could not remove that pattern"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FramedDialog
      open={open}
      onClose={onClose}
      title="Excluded from Sync"
      icon={<FolderOpen className="size-[21.33px] text-white" />}
      maxWidth="max-w-[560px]"
    >
      <div className="flex flex-col gap-4 font-sans">
        <p className="text-sm leading-5 text-grey-dark-800 dark:text-[#a3a3a3]">
          Files and folders matching these patterns are never uploaded. A
          trailing <code>/</code> excludes a folder and everything inside it.
        </p>

        <div className="flex items-start gap-2">
          <Input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleAdd();
              }
            }}
            placeholder="e.g. node_modules/ or *.tmp"
            disabled={busy}
            wrapperClassName="flex-1 min-h-12 items-center"
          />
          <Button
            type="button"
            onClick={() => void handleAdd()}
            disabled={busy || !draft.trim()}
            variant="primary"
            size="auto"
            className="h-12 shrink-0 rounded-[8px] px-5"
          >
            Add
          </Button>
        </div>

        <div className="max-h-[280px] overflow-y-auto">
          {loading ? (
            <p className="py-6 text-center text-sm text-grey-dark-800 dark:text-[#a3a3a3]">
              Loading…
            </p>
          ) : patterns.length === 0 ? (
            <p className="py-6 text-center text-sm text-grey-dark-800 dark:text-[#a3a3a3]">
              Nothing is excluded — every file in this folder syncs.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {patterns.map((pattern) => (
                <li
                  key={pattern}
                  className="flex items-center justify-between gap-3 rounded-[8px] bg-[#F4F4F4] px-3 py-2.5 dark:bg-[#2C2C2C]"
                >
                  <code className="min-w-0 truncate text-[13px] text-grey-10 dark:text-white">
                    {pattern}
                  </code>
                  <button
                    type="button"
                    aria-label={`Remove ${pattern}`}
                    disabled={busy}
                    onClick={() => void handleRemove(pattern)}
                    className="shrink-0 text-grey-10/60 transition-colors hover:text-error-50 disabled:opacity-50 dark:text-white/60"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </FramedDialog>
  );
}

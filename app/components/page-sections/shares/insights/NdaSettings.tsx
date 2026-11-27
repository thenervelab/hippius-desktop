"use client";

import { useContext, useEffect, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsToggle } from "@/app/components/page-sections/settings/SettingsToggle";
import { SwitchesUpgradeNotice } from "@/components/page-sections/drive/LinkEngagementSwitches";
import { getLinkNda, isNdaNotInPlan, removeLinkNda, setLinkNda, type LinkNda } from "@/app/lib/tauri/shareNda";
import type { LinkKind } from "@/app/lib/tauri/shareGate";
import { actionErrorLine } from "./insightsView";
import { ndaAcceptsQueryKey } from "./queryKeys";

export const NDA_LABEL = "Ask to accept an NDA";
export const NDA_DESCRIPTION = "Viewers accept your text before it opens.";
export const NDA_LOCKED_DESCRIPTION = "Viewers accept your text first. On paid Drive plans.";
/** The upgrade card's words when a free plan turns it on (the console's). */
export const NDA_LOCKED_PROMPT = "Asking to accept an NDA is available on paid Drive plans";
export const NDA_UPGRADE_BODY = "Upgrade to have viewers accept your terms first.";
export const NDA_UPGRADE_LABEL = "Upgrade to ask for an NDA";
/** A text set elsewhere whose key is not on this computer: it can only be turned off. */
export const NDA_NOT_HERE = "The text can't be opened on this computer.";

const TEXTAREA = cn(
  "min-h-[96px] w-full resize-y rounded-[8px] border px-3 py-2 text-xs outline-none disabled:opacity-60",
  "border-grey-80 bg-white text-grey-10 placeholder:text-grey-60 focus:border-primary-50",
  "dark:border-[#494949] dark:bg-[#1f1f1f] dark:text-grey-dark-800 dark:placeholder:text-grey-dark-600",
);

/**
 * A link's NDA setting as read from Rust, and the setter its editors share.
 * `null` reads nothing. A folder link (`kind` "folder") is named by its
 * token hash.
 */
export function useLinkNda(shareToken: string | null, kind: LinkKind = "file") {
  const [nda, setNda] = useState<LinkNda | null>(null);
  useEffect(() => {
    let alive = true;
    setNda(null);
    if (shareToken === null) return;
    Promise.resolve()
      .then(() => getLinkNda(shareToken, kind))
      .then((n) => alive && setNda(n))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [shareToken, kind]);
  return { nda, setNda };
}

export type LinkNdaStore = ReturnType<typeof useLinkNda>;

/**
 * "Ask to accept an NDA" on a file or folder link: viewers read the owner's
 * text and accept it on the share page before the file (or any file of the
 * folder) opens. Turning it on opens a
 * text box and Save stores the text; turning it off removes it, on every
 * plan, so an owner who left the paid plan can still open a link back up.
 *
 * Drawn only when Rust says so (`offered`): the server has NDA texts, and
 * either a text can be sealed here or the link already has one. Never on a
 * password link without one, and nothing while it is read or if the read
 * fails. Rust seals and opens the text; this only edits it.
 *
 * `layout` matches the switches it sits with: `stack` in the share dialog,
 * `list` (a bordered row) in the Insights sheet's Link settings. `store` is
 * the setting a host already read (the rule cards' summary); without one it
 * reads its own.
 */
export default function NdaSettings({
  shareToken,
  kind = "file",
  onUpgrade,
  layout = "stack",
  store,
}: {
  /** A file link's token, or a folder link's token hash. */
  shareToken: string;
  kind?: LinkKind;
  /** Opens the plans page (and closes whatever this sits in). */
  onUpgrade: () => void;
  layout?: "stack" | "list";
  store?: LinkNdaStore;
}) {
  // Optional: the share dialog has no query cache; the Insights panel does,
  // and its NDA tab is told to read again after a change.
  const queryClient = useContext(QueryClientContext);
  const own = useLinkNda(store ? null : shareToken, kind);
  const { nda, setNda } = store ?? own;

  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  // On without a stored text: the owner is writing the first one.
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const [textError, setTextError] = useState<string | null>(null);

  // The box follows the text as stored, after each read and save.
  useEffect(() => {
    setDraft(nda?.text ?? "");
  }, [nda]);
  useEffect(() => setWriting(false), [shareToken]);

  const saved = nda?.text ?? null;

  if (!nda?.offered) return null;
  const locked = nda.inPlan === false;
  const list = layout === "list";
  const on = nda.on || writing;

  const show = (next: LinkNda) => {
    setNda(next);
    void queryClient?.invalidateQueries({ queryKey: ndaAcceptsQueryKey(shareToken, kind) });
  };

  const flip = async (next: boolean) => {
    if (busy) return;
    setTextError(null);
    if (next) {
      if (locked) {
        setAsking(true);
        return;
      }
      setAsking(false);
      setDraft("");
      setWriting(true);
      return;
    }
    setAsking(false);
    if (!nda.on) {
      setWriting(false);
      setDraft("");
      return;
    }
    setBusy(true);
    try {
      await removeLinkNda(shareToken, kind);
      setWriting(false);
      show({ ...nda, on: false, text: null });
    } catch (err) {
      toast.error(actionErrorLine("change that setting", err, navigator.onLine));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy) return;
    setTextError(null);
    setBusy(true);
    try {
      show(await setLinkNda(shareToken, draft, kind));
      setWriting(false);
      toast.success("Saved");
    } catch (err) {
      const e = err as { kind?: unknown; message?: unknown } | null;
      if (isNdaNotInPlan(err)) setAsking(true);
      else if (e?.kind === "Validation" && typeof e.message === "string") setTextError(e.message);
      else toast.error(actionErrorLine("save the text", err, navigator.onLine));
    } finally {
      setBusy(false);
    }
  };

  const editable = on && nda.editable && (writing || saved !== null);
  const dirty = draft.trim() !== "" && draft.trim() !== (saved ?? "");

  return (
    <div className={cn("flex flex-col", !list && "mt-3")} data-testid="nda-settings">
      <div className={cn("flex flex-col gap-2.5", list && "rounded-[12px] border border-grey-80 px-3 py-2.5 dark:border-[#494949]")}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p
              className={cn(
                "font-medium",
                list ? "text-[13px] text-grey-10 dark:text-white" : "text-xs text-grey-30 dark:text-grey-dark-700",
              )}
            >
              {NDA_LABEL}
            </p>
            <p className="text-xs text-grey-50 dark:text-grey-dark-600">{locked ? NDA_LOCKED_DESCRIPTION : NDA_DESCRIPTION}</p>
          </div>
          <SettingsToggle ariaLabel={NDA_LABEL} checked={on} disabled={busy} onCheckedChange={(v) => void flip(v)} />
        </div>
        {nda.on && saved === null && !writing && (
          <p className="text-xs text-grey-50 dark:text-grey-dark-600" data-testid="nda-not-here">
            {NDA_NOT_HERE}
          </p>
        )}
        {editable && (
          <div className="flex flex-col gap-2.5">
            <textarea
              aria-label="NDA text"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setTextError(null);
              }}
              disabled={busy}
              rows={4}
              className={TEXTAREA}
            />
            {textError && (
              <p role="alert" className="break-words text-xs text-error-50 dark:text-error-70">
                {textError}
              </p>
            )}
            {dirty && (
              <Button
                type="button"
                variant="primary"
                size="auto"
                disabled={busy}
                onClick={() => void save()}
                className="h-[34px] self-end rounded-[8px] px-4 text-[13px] font-medium"
              >
                Save
              </Button>
            )}
          </div>
        )}
      </div>
      <div aria-live="polite">
        {asking && (
          <SwitchesUpgradeNotice
            onUpgrade={onUpgrade}
            className={list ? "mt-3" : "mt-2"}
            label={NDA_UPGRADE_LABEL}
            prompt={NDA_LOCKED_PROMPT}
            body={NDA_UPGRADE_BODY}
          />
        )}
      </div>
    </div>
  );
}

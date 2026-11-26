"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsToggle } from "@/app/components/page-sections/settings/SettingsToggle";
import { SwitchesUpgradeNotice } from "@/components/page-sections/drive/LinkEngagementSwitches";
import {
  getLinkGate,
  isGateNotInPlan,
  removeLinkGate,
  setLinkGate,
  type LinkGate,
} from "@/app/lib/tauri/shareGate";
import { actionErrorLine } from "./insightsView";

export const GATE_LABEL = "Ask for email";
export const GATE_DESCRIPTION = "Viewers confirm their email with a code before it opens.";
export const GATE_LOCKED_DESCRIPTION = "Viewers confirm their email first. On paid Drive plans.";
/** The upgrade card's words when a free plan turns it on. */
export const GATE_LOCKED_PROMPT = "Asking for an email is available on paid Drive plans";
export const GATE_UPGRADE_BODY = "Upgrade to know who opens your links.";
export const GATE_UPGRADE_LABEL = "Upgrade to ask for an email";

const TEXTAREA = cn(
  "min-h-[64px] w-full resize-y rounded-[8px] border px-3 py-2 text-xs outline-none disabled:opacity-60",
  "border-grey-80 bg-white text-grey-10 placeholder:text-grey-60 focus:border-primary-50",
  "dark:border-[#494949] dark:bg-[#1f1f1f] dark:text-grey-dark-800 dark:placeholder:text-grey-dark-600",
);

/** How many entries the stored lists hold, when they can't be opened here. */
export function gateCountsLine(gate: Pick<LinkGate, "allowCount" | "blockCount">): string {
  const parts: string[] = [];
  if (gate.allowCount > 0) parts.push(`${gate.allowCount} allowed`);
  if (gate.blockCount > 0) parts.push(`${gate.blockCount} blocked`);
  return parts.length > 0 ? `${parts.join(", ")}.` : "Anyone with an email can open it.";
}

/**
 * A link's email gate as read from Rust, and the setter its editors share.
 * `null` reads nothing (a folder link, which has no gate). Nothing while it
 * is read or if the read fails, so a link without the feature looks as it
 * always did.
 */
export function useLinkGate(shareToken: string | null) {
  const [gate, setGate] = useState<LinkGate | null>(null);
  useEffect(() => {
    let alive = true;
    setGate(null);
    if (shareToken === null) return;
    Promise.resolve()
      .then(() => getLinkGate(shareToken))
      .then((g) => alive && setGate(g))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [shareToken]);
  return { gate, setGate };
}

export type LinkGateStore = ReturnType<typeof useLinkGate>;

/**
 * "Ask for email" on a file link: viewers confirm an email with a mailed
 * code before the link opens, and the owner can let in only some addresses
 * and domains, or keep some out. Drawn only when Rust says the server has
 * email gates (`offered`).
 *
 * `layout` matches the switches it sits with: `stack` in the share dialog,
 * `list` (a bordered row) in the Insights sheet's Link settings. `store` is
 * the gate a host already read (the rule cards' summary); without one it
 * reads its own. `part` draws only the switch (the "Ask for email" card) or
 * only the lists (the "Allow list" card, where saving lists turns the gate
 * on); both by default.
 */
export default function EmailGateSettings({
  shareToken,
  onUpgrade,
  layout = "stack",
  store,
  part,
}: {
  shareToken: string;
  /** Opens the plans page (and closes whatever this sits in). */
  onUpgrade: () => void;
  layout?: "stack" | "list";
  store?: LinkGateStore;
  part?: "switch" | "lists";
}) {
  const own = useLinkGate(store ? null : shareToken);
  const { gate, setGate } = store ?? own;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [allowText, setAllowText] = useState("");
  const [blockText, setBlockText] = useState("");
  const [listError, setListError] = useState<string | null>(null);

  // The boxes follow the lists as stored, after each read and save.
  useEffect(() => {
    setAllowText(gate?.lists?.allow.join("\n") ?? "");
    setBlockText(gate?.lists?.block.join("\n") ?? "");
  }, [gate]);

  const show = (next: LinkGate) => setGate(next);

  if (!gate?.offered) return null;
  const locked = gate.inPlan === false;
  const list = layout === "list";

  const refused = (err: unknown, doing: string) => {
    if (isGateNotInPlan(err)) {
      setAsking(true);
      return;
    }
    toast.error(actionErrorLine(doing, err, navigator.onLine));
  };

  const flip = async (on: boolean) => {
    if (busy) return;
    if (on && locked) {
      setAsking(true);
      return;
    }
    setAsking(false);
    setListError(null);
    setBusy(true);
    try {
      if (on) {
        show(await setLinkGate(shareToken, "", ""));
      } else {
        await removeLinkGate(shareToken);
        show({ ...gate, on: false, allowCount: 0, blockCount: 0, lists: null });
      }
    } catch (err) {
      refused(err, "change that setting");
    } finally {
      setBusy(false);
    }
  };

  const saved = gate.on ? gate.lists : null;
  const showSwitch = part !== "lists";
  // The lists alone may be written while the gate is off: saving them turns it on.
  const listsShown = part === "lists" ? !(gate.on && gate.lists === null) : gate.on && gate.lists !== null;
  const dirty =
    saved !== null
      ? allowText !== saved.allow.join("\n") || blockText !== saved.block.join("\n")
      : part === "lists" && !gate.on && (allowText.trim() !== "" || blockText.trim() !== "");

  const save = async () => {
    if (busy) return;
    setListError(null);
    setBusy(true);
    try {
      show(await setLinkGate(shareToken, allowText, blockText));
      toast.success("Saved");
    } catch (err) {
      const message = (err as { kind?: unknown; message?: unknown } | null)?.message;
      // An entry Rust or the server would not take is named in place.
      if (!isGateNotInPlan(err) && (err as { kind?: unknown })?.kind === "Validation" && typeof message === "string") {
        setListError(message);
      } else {
        refused(err, "save the lists");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("flex flex-col", !list && "mt-3")} data-testid="email-gate-settings">
      <div className={cn("flex flex-col gap-2.5", list && "rounded-[12px] border border-grey-80 px-3 py-2.5 dark:border-[#494949]")}>
        {showSwitch && (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p
              className={cn(
                "font-medium",
                list ? "text-[13px] text-grey-10 dark:text-white" : "text-xs text-grey-30 dark:text-grey-dark-700",
              )}
            >
              {GATE_LABEL}
            </p>
            <p className="text-xs text-grey-50 dark:text-grey-dark-600">
              {locked ? GATE_LOCKED_DESCRIPTION : GATE_DESCRIPTION}
            </p>
          </div>
          <SettingsToggle
            ariaLabel={GATE_LABEL}
            checked={gate.on}
            disabled={busy}
            onCheckedChange={(on) => void flip(on)}
          />
        </div>
        )}
        {part !== "switch" && gate.on && gate.lists === null && (
          <p className="text-xs text-grey-50 dark:text-grey-dark-600" data-testid="email-gate-counts">
            {gateCountsLine(gate)}
          </p>
        )}
        {part !== "switch" && listsShown && (
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">Only allow</span>
              <textarea
                value={allowText}
                onChange={(e) => {
                  setAllowText(e.target.value);
                  setListError(null);
                }}
                disabled={busy}
                rows={2}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="Anyone with an email"
                className={TEXTAREA}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">Block</span>
              <textarea
                value={blockText}
                onChange={(e) => {
                  setBlockText(e.target.value);
                  setListError(null);
                }}
                disabled={busy}
                rows={2}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="name@company.com, company.com"
                className={TEXTAREA}
              />
            </label>
            {listError && (
              <p role="alert" className="break-words text-xs text-error-50 dark:text-error-70">
                {listError}
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
            label={GATE_UPGRADE_LABEL}
            prompt={GATE_LOCKED_PROMPT}
            body={GATE_UPGRADE_BODY}
          />
        )}
      </div>
    </div>
  );
}

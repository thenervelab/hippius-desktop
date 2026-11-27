"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsToggle } from "@/app/components/page-sections/settings/SettingsToggle";
import { SwitchesUpgradeNotice } from "@/components/page-sections/drive/LinkEngagementSwitches";
import {
  getLinkGate,
  isGateNotInPlan,
  parseGateEntries,
  removeLinkGate,
  setLinkGate,
  type GateEntry,
  type LinkGate,
  type LinkKind,
} from "@/app/lib/tauri/shareGate";
import { GateChipsInput, type GateChipsHandle } from "./GateChipsInput";
import { DriveLockedLine, UNLOCK_TO_SEE_LISTS, useDriveLocked, useDriveUnlock } from "./DriveUnlock";
import { actionErrorLine } from "./insightsView";
import { useUnlockCount } from "./useUnlockCount";

export const GATE_LABEL = "Ask for email";
export const GATE_DESCRIPTION = "Viewers confirm their email with a code before it opens.";
export const GATE_LOCKED_DESCRIPTION = "Viewers confirm their email first. On paid Drive plans.";
/** The upgrade card's words when a free plan turns it on. */
export const GATE_LOCKED_PROMPT = "Asking for an email is available on paid Drive plans";
export const GATE_UPGRADE_BODY = "Upgrade to know who opens your links.";
export const GATE_UPGRADE_LABEL = "Upgrade to ask for an email";

export const ONLY_ALLOW = "Only allow";
export const BLOCK = "Block";
/** Both boxes take several emails and whole domains. */
export const LIST_PLACEHOLDER = "Emails or domains, e.g. name@company.com, company.com";
/** What an empty Only allow means. */
export const ALLOW_ANYONE = "Anyone";
export const DOMAIN_HINT = "A domain covers everyone at it.";
/** Saving the lists of a link that asks for no email turns the asking on. */
export const SAVE_TURNS_GATE_ON = "Saving turns on Ask for email.";

const asEntries = (values: readonly string[] | undefined): GateEntry[] => (values ?? []).map((value) => ({ value, error: null }));
const sameList = (entries: readonly GateEntry[], saved: readonly string[]) =>
  entries.length === saved.length && entries.every((e, i) => e.value === saved[i]);

/** How many entries the stored lists hold, when they can't be opened here. */
export function gateCountsLine(gate: Pick<LinkGate, "allowCount" | "blockCount">): string {
  const parts: string[] = [];
  if (gate.allowCount > 0) parts.push(`${gate.allowCount} allowed`);
  if (gate.blockCount > 0) parts.push(`${gate.blockCount} blocked`);
  return parts.length > 0 ? `${parts.join(", ")}.` : "Anyone with an email can open it.";
}

/**
 * A link's email gate as read from Rust, and the setter its editors share.
 * `null` reads nothing. A folder link (`kind` "folder") is named by its
 * token hash. Nothing while it is read or if the read fails, so a link
 * without the feature looks as it always did.
 */
export function useLinkGate(shareToken: string | null, kind: LinkKind = "file") {
  const [gate, setGate] = useState<LinkGate | null>(null);
  const unlocks = useUnlockCount();
  const readFor = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    // A new link starts empty; the same link read again after an unlock keeps
    // what it shows until the answer lands.
    const key = `${kind}:${shareToken}`;
    if (readFor.current !== key) setGate(null);
    readFor.current = key;
    if (shareToken === null) return;
    Promise.resolve()
      .then(() => getLinkGate(shareToken, kind))
      .then((g) => alive && setGate(g))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [shareToken, kind, unlocks]);
  return { gate, setGate };
}

export type LinkGateStore = ReturnType<typeof useLinkGate>;

/**
 * "Ask for email" on a file or folder link: viewers confirm an email with a mailed
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
  kind = "file",
  onUpgrade,
  layout = "stack",
  store,
  part,
}: {
  /** A file link's token, or a folder link's token hash. */
  shareToken: string;
  kind?: LinkKind;
  /** Opens the plans page (and closes whatever this sits in). */
  onUpgrade: () => void;
  layout?: "stack" | "list";
  store?: LinkGateStore;
  part?: "switch" | "lists";
}) {
  const own = useLinkGate(store ? null : shareToken, kind);
  const { gate, setGate } = store ?? own;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [allow, setAllow] = useState<GateEntry[]>([]);
  const [block, setBlock] = useState<GateEntry[]>([]);
  const [typing, setTyping] = useState({ allow: false, block: false });
  const [listError, setListError] = useState<string | null>(null);
  const allowRef = useRef<GateChipsHandle>(null);
  const blockRef = useRef<GateChipsHandle>(null);
  const driveLocked = useDriveLocked();

  // The boxes follow the lists as stored, after each read and save.
  useEffect(() => {
    setAllow(asEntries(gate?.lists?.allow));
    setBlock(asEntries(gate?.lists?.block));
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
        show(await setLinkGate(shareToken, "", "", kind));
      } else {
        await removeLinkGate(shareToken, kind);
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
  // While the Drive is locked they can be neither read nor sealed here.
  const listsShown =
    !driveLocked && (part === "lists" ? !(gate.on && gate.lists === null) : gate.on && gate.lists !== null);
  const anyTyped = typing.allow || typing.block;
  const dirty =
    anyTyped ||
    (saved !== null
      ? !sameList(allow, saved.allow) || !sameList(block, saved.block)
      : part === "lists" && !gate.on && (allow.length > 0 || block.length > 0));
  const invalid = [...allow, ...block].some((e) => e.error !== null);

  // Saving only ever sets the gate (on, with these lists). It never removes
  // it: a list change, or a failed one, can't turn Ask for email off.
  const save = async () => {
    if (busy) return;
    setListError(null);
    const allowNow = (await allowRef.current?.flush()) ?? allow;
    const blockNow = (await blockRef.current?.flush()) ?? block;
    // A chip a save would refuse is already shown with Rust's sentence.
    if ([...allowNow, ...blockNow].some((e) => e.error !== null)) return;
    setBusy(true);
    try {
      show(
        await setLinkGate(
          shareToken,
          allowNow.map((e) => e.value).join("\n"),
          blockNow.map((e) => e.value).join("\n"),
          kind,
        ),
      );
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
          {driveLocked && !gate.on && !locked ? (
            // Turning it on seals the lists under the account's key: unlock first, then turn it on.
            <LockedGateToggle disabled={busy} onUnlocked={() => void flip(true)} />
          ) : (
            <SettingsToggle
              ariaLabel={GATE_LABEL}
              checked={gate.on}
              disabled={busy}
              onCheckedChange={(on) => void flip(on)}
            />
          )}
        </div>
        )}
        {part !== "switch" && gate.on && gate.lists === null && (
          <p className="text-xs text-grey-50 dark:text-grey-dark-600" data-testid="email-gate-counts">
            {gateCountsLine(gate)}
          </p>
        )}
        {part !== "switch" && driveLocked && (part === "lists" || gate.on) && <DriveLockedLine text={UNLOCK_TO_SEE_LISTS} />}
        {part !== "switch" && listsShown && (
          <div className="flex flex-col gap-2.5">
            <GateChipsInput
              ref={allowRef}
              label={ONLY_ALLOW}
              aside={ALLOW_ANYONE}
              entries={allow}
              onChange={(next) => {
                setAllow(next);
                setListError(null);
              }}
              onTyping={(t) => setTyping((was) => ({ ...was, allow: t }))}
              parse={parseGateEntries}
              placeholder={LIST_PLACEHOLDER}
              disabled={busy}
            />
            <GateChipsInput
              ref={blockRef}
              label={BLOCK}
              entries={block}
              onChange={(next) => {
                setBlock(next);
                setListError(null);
              }}
              onTyping={(t) => setTyping((was) => ({ ...was, block: t }))}
              parse={parseGateEntries}
              placeholder={LIST_PLACEHOLDER}
              disabled={busy}
            />
            <p className="text-xs text-grey-50 dark:text-grey-dark-600">
              {DOMAIN_HINT}
              {!gate.on && ` ${SAVE_TURNS_GATE_ON}`}
            </p>
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
                disabled={busy || invalid}
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

/** The Ask for email switch while the Drive is locked: pressing it unlocks, then turns it on. */
function LockedGateToggle({ disabled, onUnlocked }: { disabled: boolean; onUnlocked: () => void }) {
  const unlock = useDriveUnlock();
  return (
    <SettingsToggle
      ariaLabel={GATE_LABEL}
      checked={false}
      disabled={disabled}
      onCheckedChange={(on) => {
        if (on) unlock(onUnlocked);
      }}
    />
  );
}

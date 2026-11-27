"use client";

import { useContext, useEffect, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, Loader2, Mail, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SHARES_QUERY_KEY } from "@/app/lib/hooks/useSharedFiles";
import { SwitchesUpgradeNotice } from "@/components/page-sections/drive/LinkEngagementSwitches";
import {
  addRecipientLinks,
  getRecipientLinks,
  isRecipientsNotInPlan,
  RECIPIENTS_NOT_IN_PLAN,
  retryRecipientNda,
  revokeRecipientLink,
  type RecipientLinks as RecipientLinksView,
  type RecipientPerson,
} from "@/app/lib/tauri/shareRecipients";
import { LockMark, useDriveLocked, useDriveUnlock } from "./DriveUnlock";
import { useUnlockCount } from "./useUnlockCount";
import { actionErrorLine } from "./insightsView";
import { FOCUS } from "./panelStyles";

export const RECIPIENTS_TITLE = "Links per person";
export const UNNAMED_LINK = "Unnamed link";
export const COPY_ALL = "Copy all links";
export const NDA_PENDING_NOTE = "NDA not added yet, so this link won't open.";
/** The upgrade card's words on the free plan: links per person are paid only. */
export const RECIPIENTS_LOCKED_PROMPT = "Links per person are available on paid Drive plans";
export const RECIPIENTS_UPGRADE_BODY = "Upgrade to give each person their own link and see who opened it.";
export const RECIPIENTS_UPGRADE_LABEL = "Upgrade for links per person";

const INPUT = cn(
  "h-[38px] min-w-0 flex-1 rounded-[8px] border px-3 text-[13px] outline-none disabled:opacity-60",
  "border-grey-80 bg-white text-grey-10 placeholder:text-grey-60 focus:border-primary-50",
  "dark:border-[#494949] dark:bg-[#1f1f1f] dark:text-grey-dark-800 dark:placeholder:text-grey-dark-600",
);
const ICON_BUTTON = cn(
  "flex size-8 shrink-0 items-center justify-center rounded-md text-grey-50 transition-colors",
  "hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white",
  FOCUS,
);
const SMALL_BUTTON = cn("rounded px-2 py-1 text-[13px] font-medium", FOCUS);

/** "Name: link" per line, for every person whose link is known here and opens. */
export function allLinksText(people: readonly RecipientPerson[]): string {
  return people
    .filter((p) => p.url && !p.ndaPending)
    .map((p) => `${p.name ?? UNNAMED_LINK}: ${p.url}`)
    .join("\n");
}

/** The people to show: what Rust listed, then links just made that the listing has not caught up with. */
export function mergePeople(listed: readonly RecipientPerson[], made: readonly RecipientPerson[]): RecipientPerson[] {
  const out = listed.map((p) => {
    const fresh = made.find((m) => m.shareToken === p.shareToken);
    return fresh
      ? {
          ...p,
          url: p.url ?? fresh.url,
          mailto: p.mailto ?? fresh.mailto,
          name: p.name ?? fresh.name,
          ndaPending: p.ndaPending || fresh.ndaPending,
        }
      : p;
  });
  for (const m of made) if (!out.some((p) => p.shareToken === m.shareToken)) out.push(m);
  return out;
}

async function copyText(text: string, message: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message);
    return true;
  } catch {
    toast.error("Couldn't copy. Try again.");
    return false;
  }
}

/**
 * Links per person, under a file's link: type one or more names or emails
 * and each gets a link of its own over the same stored copy. Copy one, copy
 * them all, open one in the mail app, or revoke one while the others keep
 * working. Hippius never sends them.
 *
 * Drawn only when Rust says so (`offered`): the server has links per person,
 * and people can be added here or the link already has some. Rust makes,
 * names and rebuilds every link; this only draws them.
 *
 * `layout` matches what it sits with: `stack` in the share dialog, `list` (a
 * bordered box) in the Insights sheet's Link settings.
 *
 * Paid Drive plans only: on the free plan (Rust's `inPlan: false`, or the
 * server refusing a link for the plan) the upgrade card takes the place of
 * the box. Links already made stay listed, to copy or revoke.
 */
export default function RecipientLinks({
  shareToken,
  layout = "stack",
  onUpgrade,
}: {
  shareToken: string;
  layout?: "stack" | "list";
  /** Opens the plans page (and closes whatever this sits in). */
  onUpgrade?: () => void;
}) {
  // Optional: the share dialog has no query cache; the Insights panel does.
  const queryClient = useContext(QueryClientContext);
  const [view, setView] = useState<RecipientLinksView | null>(null);
  const [made, setMade] = useState<RecipientPerson[]>([]);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  // Links whose NDA was added here since the list was read.
  const [unlocked, setUnlocked] = useState<ReadonlySet<string>>(new Set());
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server refused a link for the plan after Rust could not read it.
  const [refusedForPlan, setRefusedForPlan] = useState(false);
  // People can be added only once the Drive is unlocked here (Rust's `canAdd`).
  const driveLocked = useDriveLocked();
  const unlocks = useUnlockCount();

  const load = () =>
    Promise.resolve()
      .then(() => getRecipientLinks(shareToken))
      .then(setView)
      .catch(() => undefined);

  useEffect(() => {
    setView(null);
    setMade([]);
    setGone(new Set());
    setUnlocked(new Set());
    setRefusedForPlan(false);
    let alive = true;
    Promise.resolve()
      .then(() => getRecipientLinks(shareToken))
      .then((v) => alive && setView(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [shareToken]);

  // Unlocked while open: read again, so the box to add people appears.
  useEffect(() => {
    if (unlocks > 0) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocks]);

  if (!view?.offered) return null;
  const people = mergePeople(view.people, made)
    .filter((p) => !gone.has(p.shareToken))
    .map((p) => (p.ndaPending && unlocked.has(p.shareToken) ? { ...p, ndaPending: false } : p));
  const list = layout === "list";

  const refreshElsewhere = () => {
    void queryClient?.invalidateQueries({ queryKey: [SHARES_QUERY_KEY] });
    void queryClient?.invalidateQueries({ queryKey: ["share-group-insights"] });
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || input.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const added = await addRecipientLinks(shareToken, input);
      setMade((prev) => [...prev, ...added.people]);
      setInput(added.left);
      if (added.error === RECIPIENTS_NOT_IN_PLAN) {
        setRefusedForPlan(true);
        setError(null);
      } else {
        setError(added.error);
      }
      if (added.people.length > 0) {
        refreshElsewhere();
        void load();
      }
    } catch (err) {
      if (isRecipientsNotInPlan(err)) setRefusedForPlan(true);
      else setError(actionErrorLine("make the link", err, navigator.onLine));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (person: RecipientPerson) => {
    try {
      await revokeRecipientLink(person.shareToken);
      setGone((prev) => new Set(prev).add(person.shareToken));
      toast.success(person.name ? `Link for ${person.name} revoked` : "Link revoked");
      refreshElsewhere();
    } catch (err) {
      toast.error(actionErrorLine("revoke the link", err, navigator.onLine));
    }
  };

  const retryNda = async (person: RecipientPerson) => {
    try {
      await retryRecipientNda(shareToken, person.shareToken);
      setUnlocked((prev) => new Set(prev).add(person.shareToken));
      toast.success(person.name ? `NDA added to the link for ${person.name}` : "NDA added to the link");
    } catch (err) {
      toast.error(actionErrorLine("add the NDA", err, navigator.onLine));
    }
  };

  const allText = allLinksText(people);
  const locked = view.inPlan === false || refusedForPlan;

  return (
    <section
      aria-labelledby={`recipients-${shareToken}`}
      className={cn("flex flex-col gap-2", list ? "rounded-[12px] border border-grey-80 px-3 py-2.5 dark:border-[#494949]" : "mt-3")}
      data-testid="recipient-links"
    >
      <h3
        id={`recipients-${shareToken}`}
        className={cn(
          "font-medium",
          list ? "text-[13px] text-grey-10 dark:text-white" : "text-xs text-grey-30 dark:text-grey-dark-700",
        )}
      >
        {RECIPIENTS_TITLE}
      </h3>
      {view.canAdd && locked && (
        <SwitchesUpgradeNotice
          onUpgrade={onUpgrade ?? (() => undefined)}
          label={RECIPIENTS_UPGRADE_LABEL}
          prompt={RECIPIENTS_LOCKED_PROMPT}
          body={RECIPIENTS_UPGRADE_BODY}
        />
      )}
      {!view.canAdd && driveLocked && <LockedAddRow onUnlocked={() => void load()} />}
      {view.canAdd && !locked && (
        <form className="flex min-w-0 items-center gap-2" onSubmit={(e) => void add(e)}>
          <input
            aria-label="Names or emails"
            placeholder="Name or email"
            value={input}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            className={INPUT}
          />
          <Button
            type="submit"
            variant="primary"
            size="auto"
            disabled={busy || input.trim() === ""}
            className="h-[38px] shrink-0 rounded-[8px] px-4 text-[13px] font-medium"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-label="Adding" /> : "Add"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-error-50 dark:text-error-70">
          {error}
        </p>
      )}
      {people.length > 0 && (
        <ul aria-label="People" className="flex flex-col">
          {people.map((person) => (
            <PersonRow
              key={person.shareToken}
              person={person}
              onRevoke={() => revoke(person)}
              onRetryNda={() => retryNda(person)}
            />
          ))}
        </ul>
      )}
      {people.length > 1 && allText && (
        <div>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-primary-50 hover:underline dark:text-primary-brand-dark",
              FOCUS,
            )}
            onClick={() => void copyText(allText, "Links copied")}
          >
            <Copy className="size-3.5" aria-hidden />
            {COPY_ALL}
          </button>
        </div>
      )}
    </section>
  );
}

function PersonRow({
  person,
  onRevoke,
  onRetryNda,
}: {
  person: RecipientPerson;
  onRevoke: () => Promise<void>;
  onRetryNda: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const name = person.name ?? UNNAMED_LINK;

  if (confirming) {
    return (
      <li className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-1" data-testid="recipient-row">
        <span className="min-w-0 flex-1 truncate text-[13px] text-grey-10 dark:text-white">Revoke link for {name}?</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            disabled={revoking}
            onClick={() => {
              setRevoking(true);
              void onRevoke().finally(() => setRevoking(false));
            }}
            className={cn(SMALL_BUTTON, "text-error-50 hover:bg-error-50/10 dark:text-error-70")}
          >
            Revoke
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className={cn(SMALL_BUTTON, "text-grey-10 hover:bg-grey-90 dark:text-white dark:hover:bg-white/10")}
          >
            Cancel
          </button>
        </span>
      </li>
    );
  }

  return (
    <li className="flex min-h-10 min-w-0 items-center gap-1 py-1" data-testid="recipient-row">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-grey-10 dark:text-white" title={name}>
          {name}
        </span>
        {person.ndaPending && <span className="text-xs text-error-50 dark:text-error-70">{NDA_PENDING_NOTE}</span>}
      </span>
      {person.ndaPending && (
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void onRetryNda().finally(() => setRetrying(false));
          }}
          className={cn(SMALL_BUTTON, "shrink-0 text-primary-50 hover:bg-grey-90 dark:text-primary-brand-dark dark:hover:bg-white/10")}
        >
          {retrying ? <Loader2 className="size-4 animate-spin" aria-label="Adding the NDA" /> : "Try again"}
        </button>
      )}
      {!person.ndaPending && person.mailto && (
        <button
          type="button"
          aria-label={`Email link to ${name}`}
          title="Open in your mail app"
          className={ICON_BUTTON}
          onClick={() => void openUrl(person.mailto!).catch(() => toast.error("Couldn't open your mail app."))}
        >
          <Mail className="size-4" aria-hidden />
        </button>
      )}
      {!person.ndaPending && person.url && (
        <button
          type="button"
          aria-label={`Copy link for ${name}`}
          title={copied ? "Copied" : "Copy link"}
          className={ICON_BUTTON}
          onClick={() =>
            void copyText(person.url!, person.name ? `Link for ${person.name} copied` : "Link copied").then(setCopied)
          }
        >
          {copied ? <Check className="size-4 text-success-50" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        </button>
      )}
      <button
        type="button"
        aria-label={`Revoke link for ${name}`}
        title="Revoke"
        className={ICON_BUTTON}
        onClick={() => setConfirming(true)}
      >
        <X className="size-4" aria-hidden />
      </button>
    </li>
  );
}

/**
 * In place of the box while the Drive is locked: it looks like the box, with
 * a lock, and pressing it unlocks, then reads the list again so the real box
 * appears.
 */
function LockedAddRow({ onUnlocked }: { onUnlocked: () => void }) {
  const unlock = useDriveUnlock();
  return (
    <button
      type="button"
      onClick={() => unlock(onUnlocked)}
      data-testid="recipient-links-locked"
      className={cn(INPUT, "flex h-[38px] w-full flex-none items-center justify-between gap-2 text-left text-grey-60 dark:text-grey-dark-600", FOCUS)}
    >
      <span className="truncate">Unlock your Drive to add people</span>
      <LockMark />
    </button>
  );
}

// What the large-delete prompt shows, per drive side, folded from Rust's
// events. Pure functions over an immutable Map so every transition is
// unit-testable without a Tauri runtime.
//
// Rust owns the hold itself (side, count, state, whether this account may
// restore). The only state added here is presentation: whether the user
// chose "Decide later" for this hold, the answer they just sent (so the
// banner does not offer the same buttons again while the next cycle applies
// it), the last refusal, and a one-line notice after a refused answer.

import type {
  MassDeleteHold,
  MassDeleteRestoreRefusedPayload,
  MassDeleteSide,
  MassDeleteSidePayload,
} from "@/app/lib/tauri/massDelete";

export interface MassDeleteRefusal {
  reason: string;
  neededBytes: number | null;
}

export interface MassDeleteHoldView extends MassDeleteHold {
  /** "Decide later": hidden until the next hold event for this side. */
  dismissed: boolean;
  /** The answer sent and accepted, until a cycle applies it. */
  requested: "restore" | "remove" | null;
  /** The last refused restore for this hold, if any. */
  refusal: MassDeleteRefusal | null;
  /** Why the prompt is asking again (e.g. the count changed). */
  notice: string | null;
}

export type MassDeleteHolds = Map<string, MassDeleteHoldView>;

/** Map key for one drive side. NUL cannot appear in a label. */
export function holdKey(label: string, side: MassDeleteSide): string {
  return `${label}\u0000${side}`;
}

function viewOf(hold: MassDeleteHold): MassDeleteHoldView {
  return { ...hold, dismissed: false, requested: null, refusal: null, notice: null };
}

/**
 * A `hcfs_mass_delete_held` event: Rust emits it only when the hold began or
 * changed, so it always re-raises a dismissed banner and drops an answer the
 * new hold has overtaken. A refusal survives (hcfs reports the hold again
 * right after refusing a restore).
 */
export function applyHeld(holds: MassDeleteHolds, hold: MassDeleteHold): MassDeleteHolds {
  const key = holdKey(hold.label, hold.side);
  const previous = holds.get(key);
  const next = new Map(holds);
  next.set(key, { ...viewOf(hold), refusal: previous?.refusal ?? null });
  return next;
}

/** `hcfs_mass_delete_cleared`: the hold ended (removed, restored, or back). */
export function applyCleared(
  holds: MassDeleteHolds,
  { label, side }: MassDeleteSidePayload,
): MassDeleteHolds {
  const key = holdKey(label, side);
  if (!holds.has(key)) return holds;
  const next = new Map(holds);
  next.delete(key);
  return next;
}

/** `hcfs_mass_delete_restored`: restoring until the next cycle clears it. */
export function applyRestored(
  holds: MassDeleteHolds,
  { label, side }: MassDeleteSidePayload,
): MassDeleteHolds {
  const key = holdKey(label, side);
  const current = holds.get(key);
  if (!current) return holds;
  const next = new Map(holds);
  next.set(key, { ...current, state: "restoring", requested: null, refusal: null, notice: null });
  return next;
}

/** `hcfs_mass_delete_restore_refused`: the hold stands, with a reason. */
export function applyRefused(
  holds: MassDeleteHolds,
  payload: MassDeleteRestoreRefusedPayload,
): MassDeleteHolds {
  const key = holdKey(payload.label, payload.side);
  const current = holds.get(key);
  if (!current) return holds;
  const next = new Map(holds);
  next.set(key, {
    ...current,
    dismissed: false,
    requested: null,
    refusal: { reason: payload.reason, neededBytes: payload.neededBytes },
  });
  return next;
}

/**
 * Replace the map with Rust's current holds (start, reload, or a refresh
 * after a "nothing held" refusal). A hold that is unchanged keeps its
 * presentation state, so a refresh does not re-raise a dismissed banner.
 */
export function applyHydration(
  holds: MassDeleteHolds,
  current: MassDeleteHold[],
): MassDeleteHolds {
  const next: MassDeleteHolds = new Map();
  for (const hold of current) {
    const key = holdKey(hold.label, hold.side);
    const previous = holds.get(key);
    const same =
      previous !== undefined &&
      previous.count === hold.count &&
      previous.state === hold.state &&
      previous.syncedCount === hold.syncedCount;
    next.set(key, same ? { ...previous, ...hold } : viewOf(hold));
  }
  return next;
}

/** Patch one side's presentation state; no-op for a side with no hold. */
export function updateHold(
  holds: MassDeleteHolds,
  key: string,
  patch: Partial<MassDeleteHoldView>,
): MassDeleteHolds {
  const current = holds.get(key);
  if (!current) return holds;
  const next = new Map(holds);
  next.set(key, { ...current, ...patch });
  return next;
}

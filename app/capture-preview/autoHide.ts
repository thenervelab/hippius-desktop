/**
 * The countdown before a finished capture card slides away, as plain values
 * so it can be tested without React or a real clock.
 *
 * The card is held while the pointer is on it or keyboard focus is in it.
 * A hold is a pause, never a restart: letting go runs the countdown on with
 * the time it had left, so the card goes when its timer bar runs out, however
 * often the pointer passed over it. Every function takes `now` from one
 * monotonic clock (`performance.now()` on the page) and returns a new value,
 * or the same one when nothing changed, so React skips the render.
 */

export interface Countdown {
  /** The card it counts down for. Another card starts its own. */
  cardId: number;
  /** The whole countdown, in ms. */
  totalMs: number;
  /** The time that was left when it last paused or started, in ms. */
  leftMs: number;
  /** When it last started running, on the caller's clock; null while held. */
  runningSince: number | null;
}

/** A countdown of `totalMs` for `cardId`, running from `now` unless the card is held already. */
export function startCountdown(cardId: number, totalMs: number, now: number, held: boolean): Countdown {
  return { cardId, totalMs, leftMs: totalMs, runningSince: held ? null : now };
}

/**
 * The time left at `now`: what was left at the last pause or start, less the
 * time it has run since. Never below zero, and never more than was left, so
 * a clock read out of order cannot give the card time back.
 */
export function timeLeft(countdown: Countdown, now: number): number {
  if (countdown.runningSince === null) return countdown.leftMs;
  const ran = Math.max(0, now - countdown.runningSince);
  return Math.max(0, countdown.leftMs - ran);
}

/** Holds the countdown at `now`, keeping the time it had left. */
export function pauseCountdown(countdown: Countdown, now: number): Countdown {
  if (countdown.runningSince === null) return countdown;
  return { ...countdown, leftMs: timeLeft(countdown, now), runningSince: null };
}

/** Runs a held countdown on from `now` with the time it had left. */
export function resumeCountdown(countdown: Countdown, now: number): Countdown {
  if (countdown.runningSince !== null) return countdown;
  return { ...countdown, runningSince: now };
}

/**
 * The countdown once the settled card or its hold changed: none while no
 * card is settled, a fresh one for a card that has just settled (or for
 * another card), otherwise the same one, paused or resumed.
 */
export function nextCountdown(
  previous: Countdown | null,
  settledCardId: number | null,
  held: boolean,
  totalMs: number,
  now: number,
): Countdown | null {
  if (settledCardId === null) return null;
  if (!previous || previous.cardId !== settledCardId) return startCountdown(settledCardId, totalMs, now, held);
  return held ? pauseCountdown(previous, now) : resumeCountdown(previous, now);
}

/**
 * Where the timer bar starts, in ms into its animation: the time already run
 * at the last pause or start. The bar is drawn afresh at each pause with this
 * as a negative delay, so it shows the countdown's own time left and runs on
 * from there when let go.
 */
export function barOffsetMs(countdown: Countdown): number {
  return countdown.totalMs - countdown.leftMs;
}

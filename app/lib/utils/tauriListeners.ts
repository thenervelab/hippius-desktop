import { listen, type Event, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { errorMessage } from "@/lib/utils/errorUtils";

/** How often, and how long, a refused unlisten is tried again (`safeUnlisten`). */
const UNLISTEN_RETRY_MS = 100;
const UNLISTEN_TRIES = 10;

/**
 * An unlisten that is safe to call at any moment, any number of times.
 *
 * Tauri's `listen()` answers before the page holds the listener's entry: Rust
 * adds it with a separate script, which can land a little later on a busy
 * app (a recording starting, a window opening). An unlisten in that gap
 * throws inside Tauri ("listeners[eventId].handlerId") before Rust is told,
 * so the listener stays live, and the rejection surfaces as an unhandled
 * error. Here a second call does nothing, and a refused unlisten is tried
 * again shortly, once the entry has landed, so Rust drops it after all.
 */
export function safeUnlisten(unlisten: UnlistenFn): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    const attempt = (triesLeft: number) => {
      const retry = () => {
        if (triesLeft > 1) setTimeout(() => attempt(triesLeft - 1), UNLISTEN_RETRY_MS);
      };
      // Called at once, as a bare unlisten is: the page stops hearing the
      // event now, not a tick later. Tauri's unlisten is async, so its
      // refusal arrives as a rejection; a synchronous throw is caught too.
      try {
        Promise.resolve(unlisten()).catch(retry);
      } catch {
        retry();
      }
    };
    attempt(UNLISTEN_TRIES);
  };
}

/** `onTauriEvent`'s cleanup; `ready` resolves once the listener is registered (or failed to be). */
export type TauriEventCleanup = (() => void) & { ready: Promise<void> };

/**
 * `listen()` for an effect: returns the effect's cleanup at once. The handler
 * runs only until that cleanup, however late Tauri drops the listener, and
 * the cleanup is safe before `listen()` has answered, and twice (StrictMode,
 * an effect torn down while its listener is still registering).
 */
export function onTauriEvent<T>(event: string, handler: EventCallback<T>): TauriEventCleanup {
  let live = true;
  let stop: (() => void) | null = null;
  const ready = listen<T>(event, (e) => {
    if (live) handler(e);
  })
    .then((unlisten) => {
      stop = safeUnlisten(unlisten);
      if (!live) stop();
    })
    .catch((err) => console.warn(`[TauriListeners] Failed to register ${event}:`, errorMessage(err)));
  const cleanup = () => {
    if (!live) return;
    live = false;
    stop?.();
  };
  return Object.assign(cleanup, { ready });
}

/**
 * Register multiple Tauri event listeners sequentially. Returns a cleanup
 * function safe for useEffect returns. Sequential registration prevents
 * listener leaks on partial failure.
 *
 * `ready` resolves once every registration has been attempted (or cleanup
 * cut it short). A caller that reads state and then relies on events to
 * keep it current awaits it before reading: an event emitted before its
 * listener exists is lost.
 */
export function registerTauriListeners(
  registrations: Array<[string, (event: Event<unknown>) => void]>
): { cleanup: () => void; ready: Promise<void> } {
  let cancelled = false;
  const unsubs: Array<() => void> = [];

  const ready = (async () => {
    for (const [event, handler] of registrations) {
      if (cancelled) return;
      try {
        const unsub = safeUnlisten(await listen(event, handler));
        if (cancelled) {
          unsub();
        } else {
          unsubs.push(unsub);
        }
      } catch (err) {
        console.warn(
          `[TauriListeners] Failed to register ${event}:`,
          errorMessage(err)
        );
      }
    }
  })();

  return {
    ready,
    cleanup: () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      unsubs.length = 0;
    },
  };
}

import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import { errorMessage } from "@/lib/utils/errorUtils";

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
  const unsubs: UnlistenFn[] = [];

  const ready = (async () => {
    for (const [event, handler] of registrations) {
      if (cancelled) return;
      try {
        const unsub = await listen(event, handler);
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

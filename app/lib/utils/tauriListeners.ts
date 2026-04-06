import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import { errorMessage } from "@/lib/utils/errorUtils";

/**
 * Register multiple Tauri event listeners sequentially. Returns a cleanup
 * function safe for useEffect returns. Sequential registration prevents
 * listener leaks on partial failure.
 */
export function registerTauriListeners(
  registrations: Array<[string, (event: Event<unknown>) => void]>
): { cleanup: () => void } {
  let cancelled = false;
  const unsubs: UnlistenFn[] = [];

  (async () => {
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
    cleanup: () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      unsubs.length = 0;
    },
  };
}

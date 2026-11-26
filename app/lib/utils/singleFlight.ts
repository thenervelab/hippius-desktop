/**
 * Wrap an async call so that only one runs at a time: a call made while the
 * previous one is still pending gets that same pending promise instead of
 * starting another.
 *
 * For pollers that ask the backend on a timer. If the backend is slow or has
 * stopped answering, a plain `setInterval(() => invoke(...))` starts a new
 * call on every tick while none of the old ones ever settle, and they pile up
 * for as long as the window stays open.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    const call = run().finally(() => {
      if (pending === call) pending = null;
    });
    pending = call;
    return call;
  };
}

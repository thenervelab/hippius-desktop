import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

/**
 * Wrap a Tauri `invoke()` call with a wall-clock timeout.
 *
 * Tauri IPC has no built-in client-side deadline — an `invoke()` that
 * never returns (Rust hangs on a lock, awaits a never-fulfilled
 * future, panics inside a `spawn_blocking` task whose result is then
 * orphaned, etc.) leaves the FE promise pending forever. The first
 * surface bug fixed with this pattern was `get_user_files` spinning
 * the Files page indefinitely; `use-user-files/index.ts` inlined the
 * `Promise.race` + `clearTimeout` dance and the comment there
 * explains the original reasoning in full.
 *
 * This helper extracts that pattern so other IPCs that orchestrate
 * the sync engine (auto_init_sync, ensure_sync_mnemonic, stop_sync,
 * restore_session) can opt into the same wall-clock cap without
 * recopying the boilerplate. The timer is cleared in `finally`, so
 * the happy path doesn't leak a pending `setTimeout` per call —
 * which would accumulate noticeably under TanStack Query refetch
 * storms or event-driven re-issues.
 *
 * @param command   Tauri command name, identical to `invoke()`'s first arg.
 * @param args      Tauri command args, identical to `invoke()`'s second arg.
 * @param timeoutMs Wall-clock timeout in milliseconds. A throw with a
 *                  predictable message (`"<command> timed out"`) lets
 *                  callers match on it without reflection.
 *
 * @returns The same `Promise<T>` shape `invoke()` returns.
 * @throws  The original error from `invoke()` if the IPC itself
 *          rejected; otherwise a `new Error("<command> timed out")`
 *          when the budget elapses.
 *
 * Caller pattern:
 * ```ts
 * try {
 *   const result = await invokeWithTimeout<MyResult>(
 *     "my_command",
 *     { someArg: 1 },
 *     5_000,
 *   );
 * } catch (err) {
 *   if (err instanceof Error && err.message.endsWith("timed out")) {
 *     // surface timeout-specific UX
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export async function invokeWithTimeout<T>(
  command: string,
  args: InvokeArgs | undefined,
  timeoutMs: number,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${command} timed out`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      invoke<T>(command, args),
      timeout,
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

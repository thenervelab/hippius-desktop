import { invoke } from "@tauri-apps/api/core";

/** Module-level promise to prevent concurrent generation. */
let inflightPromise: Promise<string> | null = null;

/**
 * Ensures a BIP-39 mnemonic is available for HCFS sync.
 *
 * Resolution order:
 * 1. Drive's encrypted mnemonic on disk (via `get_drive_mnemonic` Tauri command)
 * 2. Generate a new 12-word mnemonic as a last resort (OAuth users)
 *
 * The mnemonic is passed directly to sync init — never persisted to the
 * frontend session DB.
 */
export async function ensureSyncMnemonic(
  accountId?: string
): Promise<string> {
  if (inflightPromise) return inflightPromise;
  inflightPromise = doEnsure(accountId).finally(() => {
    inflightPromise = null;
  });
  return inflightPromise;
}

async function doEnsure(accountId?: string): Promise<string> {
  // 1. Try to retrieve the Drive's actual mnemonic from the backend
  if (accountId) {
    try {
      const driveMnemonic = await invoke<string>("get_drive_mnemonic", {
        accountId,
      });
      if (driveMnemonic) {
        console.log(
          "[ensureSyncMnemonic] Retrieved mnemonic from Drive"
        );
        return driveMnemonic;
      }
    } catch {
      // Drive not initialized or password not available — fall through
    }
  }

  // 2. Generate a new mnemonic via Rust (OAuth users on first sync)
  const mnemonic = await invoke<string>("generate_mnemonic");

  console.log(
    "[ensureSyncMnemonic] Generated new mnemonic for OAuth user"
  );
  return mnemonic;
}

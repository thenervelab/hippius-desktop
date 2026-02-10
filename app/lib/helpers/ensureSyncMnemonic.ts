import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";
import { invoke } from "@tauri-apps/api/core";
import { getSession } from "./sessionStore";
import {
  ensureWalletTable,
  initHippiusDesktopDB,
  saveBytes,
} from "./hippiusDesktopDB";

/** Module-level promise to prevent concurrent generation. */
let inflightPromise: Promise<string> | null = null;

/**
 * Persist a mnemonic into the session's oauthMnemonic column without wiping
 * authToken / tokenExpiry or other columns.
 */
async function persistMnemonicToSession(mnemonic: string): Promise<void> {
  await ensureWalletTable();
  const db = await initHippiusDesktopDB();
  const res = db.exec("SELECT id FROM session LIMIT 1");
  if (res.length && res[0].values.length) {
    db.run("UPDATE session SET oauthMnemonic = ? WHERE id = ?", [
      mnemonic,
      res[0].values[0][0],
    ]);
  } else {
    db.run(
      "INSERT INTO session (mnemonic, oauthMnemonic, logoutTimeStamp, logoutTimeInMinutes) VALUES (?, ?, ?, ?)",
      ["", mnemonic, 0, -1]
    );
  }
  await saveBytes(db.export());
}

/**
 * Ensures a BIP-39 mnemonic exists in the session store for HCFS sync.
 *
 * Resolution order:
 * 1. IndexedDB session (already stored from a previous call or mnemonic login)
 * 2. Drive's encrypted mnemonic on disk (via `get_drive_mnemonic` Tauri command)
 * 3. Generate a new 12-word mnemonic as a last resort
 *
 * Includes a concurrency guard so concurrent callers share a single result.
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
  // 1. Check IndexedDB session
  const session = await getSession();
  if (session?.mnemonic) {
    return session.mnemonic;
  }

  // 2. Try to retrieve the Drive's actual mnemonic from the backend
  if (accountId) {
    try {
      const driveMnemonic = await invoke<string>("get_drive_mnemonic", {
        accountId,
      });
      if (driveMnemonic) {
        console.log(
          "[ensureSyncMnemonic] Retrieved mnemonic from Drive"
        );
        await persistMnemonicToSession(driveMnemonic);
        return driveMnemonic;
      }
    } catch {
      // Drive not initialized or password not available — fall through
    }
  }

  // 3. Generate a new mnemonic
  await cryptoWaitReady();
  const mnemonic = mnemonicGenerate(12);
  await persistMnemonicToSession(mnemonic);

  console.log(
    "[ensureSyncMnemonic] Generated and stored new mnemonic for OAuth user"
  );
  return mnemonic;
}

import {
  ensureWalletTable,
  initHippiusDesktopDB,
  saveBytes,
} from "./hippiusDesktopDB";

const FOREVER_MS = 1000 * 60 * 60 * 24 * 365 * 100;

export async function saveSession(
  mnemonic: string,
  logoutTimeInMinutes?: number
): Promise<number> {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();

    // Use explicit param if provided, else keep previous, else default 1440
    const prev = await getSession();
    const effectiveMinutes =
      logoutTimeInMinutes ?? prev?.logoutTimeInMinutes ?? 1440;

    const logoutTimeStamp =
      effectiveMinutes === -1
        ? Date.now() + FOREVER_MS
        : Date.now() + effectiveMinutes * 60_000;

    db.run("DELETE FROM session");
    db.run(
      "INSERT INTO session (mnemonic, logoutTimeStamp, logoutTimeInMinutes) VALUES (?, ?, ?)",
      [mnemonic, logoutTimeStamp, effectiveMinutes]
    );

    await saveBytes(db.export());
    return logoutTimeStamp;
  } catch (err) {
    console.error("Failed to save session:", err);
    throw err;
  }
}

export async function getSession(): Promise<{
  mnemonic: string;
  logoutTimeStamp: number;
  logoutTimeInMinutes: number;
} | null> {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();

    const res = db.exec(
      "SELECT mnemonic, logoutTimeStamp, logoutTimeInMinutes FROM session LIMIT 1"
    );

    if (!res.length || !res[0]?.values.length) {
      return null;
    }

    const [mnemonic, logoutTimeStamp, logoutTimeInMinutes] = res[0]
      .values[0] as [string, number, number];
    return {
      mnemonic,
      logoutTimeStamp,
      logoutTimeInMinutes: logoutTimeInMinutes || 1440,
    };
  } catch (err) {
    console.error("Error fetching session:", err);
    return null;
  }
}

export async function updateSessionTimeout(logoutTimeInMinutes: number) {
  try {
    const session = await getSession();
    if (!session) return false;

    await saveSession(session.mnemonic, logoutTimeInMinutes);
    return true;
  } catch (err) {
    console.error("Error updating session timeout:", err);
    return false;
  }
}

export async function clearSession() {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();

    // keep previously chosen minutes (fallback to 24h)
    const res = db.exec("SELECT logoutTimeInMinutes FROM session LIMIT 1");
    const minutes =
      res.length && res[0].values.length
        ? Number(res[0].values[0][0]) || 1440
        : 1440;

    if (res.length && res[0].values.length) {
      // Row exists: only clear active session data
      db.run(
        "UPDATE session SET mnemonic = ?, logoutTimeStamp = ?, logoutTimeInMinutes = ?",
        ["", 0, minutes]
      );
    } else {
      // No row yet: create placeholder carrying the minutes
      db.run(
        "INSERT INTO session (mnemonic, logoutTimeStamp, logoutTimeInMinutes) VALUES (?, ?, ?)",
        ["", 0, minutes]
      );
    }

    await saveBytes(db.export());
    return true;
  } catch (err) {
    console.error("Failed to clear session:", err);
    return false;
  }
}

import {
  ensureWalletTable,
  initHippiusDesktopDB,
  saveBytes,
  ensureSessionAuthColumns,
} from "./hippiusDesktopDB";

const FOREVER_MS = 1000 * 60 * 60 * 24 * 365 * 100;

// API/AUTH constants and helpers
export const API_CONFIG = {
  baseUrl: process.env.NEXT_PUBLIC_API_URL || "https://api.hippius.com",
  billing: {
    transactions: "/api/billing/transactions/",
    activeSubscription: "/api/billing/stripe/active-subscription/",
    plans: "/api/billing/stripe/subscription-plans/",
    depositAddress: "/api/billing/deposit-address/",
    customerPortal: "/api/billing/stripe/customer-portal/",
    createSubscription: "/api/billing/stripe/create-subscription/"
  },
  auth: {
    mnemonic: "/api/auth/mnemonic/",
    verify: "/api/auth/verify/",
  },
} as const;

export const AUTH_CONFIG = {
  tokenStorageKey: "hippius_session_token", // retained for parity, not used in DB mode
  tokenExpiryKey: "hippius_token_expiry",   // retained for parity, not used in DB mode
  tokenScheme: "Token", // or "Bearer" depending on backend
  defaultTtlHours: 24,
} as const;

export type ApiAuth = {
  token: string;
  tokenExpiry: number; // epoch ms
  userId?: number | null;
  username?: string | null;
};

// Persist API auth in the session table (single-row model)
export async function setApiAuth(
  token: string,
  opts?: { ttlHours?: number; userId?: number; username?: string; absoluteExpiryMs?: number }
) {
  await ensureWalletTable();
  await ensureSessionAuthColumns();
  const db = await initHippiusDesktopDB();

  const now = Date.now();
  const tokenExpiry =
    typeof opts?.absoluteExpiryMs === "number"
      ? opts.absoluteExpiryMs
      : now + (opts?.ttlHours ?? AUTH_CONFIG.defaultTtlHours) * 60 * 60 * 1000;

  const res = db.exec("SELECT id FROM session LIMIT 1");
  if (res.length && res[0].values.length) {
    db.run(
      "UPDATE session SET authToken = ?, tokenExpiry = ?, userId = ?, username = ? WHERE id = ?",
      [token, tokenExpiry, opts?.userId ?? null, opts?.username ?? null, res[0].values[0][0]]
    );
  } else {
    db.run(
      "INSERT INTO session (mnemonic, logoutTimeStamp, logoutTimeInMinutes, authToken, tokenExpiry, userId, username) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["", 0, 1440, token, tokenExpiry, opts?.userId ?? null, opts?.username ?? null]
    );
  }
  await saveBytes(db.export());
}

export async function getApiAuth(): Promise<ApiAuth | null> {
  try {
    await ensureWalletTable();
    await ensureSessionAuthColumns();
    const db = await initHippiusDesktopDB();
    const res = db.exec(
      "SELECT authToken, tokenExpiry, userId, username FROM session LIMIT 1"
    );
    if (!res.length || !res[0].values.length) return null;
    const [token, tokenExpiry, userId, username] = res[0].values[0] as [
      string | null,
      number | null,
      number | null,
      string | null
    ];
    if (!token) return null;
    return {
      token,
      tokenExpiry: Number(tokenExpiry || 0),
      userId: userId != null ? Number(userId) : undefined,
      username: (username as string | null) ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function clearApiAuth() {
  try {
    await ensureWalletTable();
    await ensureSessionAuthColumns();
    const db = await initHippiusDesktopDB();
    const res = db.exec("SELECT id FROM session LIMIT 1");
    if (res.length && res[0].values.length) {
      db.run(
        "UPDATE session SET authToken = ?, tokenExpiry = ?, userId = ?, username = ? WHERE id = ?",
        [null, null, null, null, res[0].values[0][0]]
      );
    }
    await saveBytes(db.export());
    return true;
  } catch {
    return false;
  }
}

export async function getAuthHeaders(): Promise<HeadersInit | null> {
  const auth = await getApiAuth();
  if (!auth || !auth.token || (auth.tokenExpiry && auth.tokenExpiry < Date.now())) {
    return null;
  }
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `${AUTH_CONFIG.tokenScheme} ${auth.token}`,
  };
}

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
    await ensureSessionAuthColumns();
    const db = await initHippiusDesktopDB();

    // keep previously chosen minutes (fallback to 24h)
    const res = db.exec("SELECT logoutTimeInMinutes, id FROM session LIMIT 1");
    const hasRow = res.length && res[0].values.length;
    const id = hasRow ? Number(res[0].values[0][1]) : null;
    const minutes =
      hasRow ? Number(res[0].values[0][0]) || 1440 : 1440;

    if (hasRow && id != null) {
      // Clear active session data + API auth
      db.run(
        "UPDATE session SET mnemonic = ?, logoutTimeStamp = ?, logoutTimeInMinutes = ?, authToken = ?, tokenExpiry = ?, userId = ?, username = ? WHERE id = ?",
        ["", 0, minutes, null, null, null, null, id]
      );
    } else {
      // No row yet: create placeholder carrying the minutes
      db.run(
        "INSERT INTO session (mnemonic, logoutTimeStamp, logoutTimeInMinutes, authToken, tokenExpiry, userId, username) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["", 0, minutes, null, null, null, null]
      );
    }

    await saveBytes(db.export());
    return true;
  } catch (err) {
    console.error("Failed to clear session:", err);
    return false;
  }
}

import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import { initHippiusDesktopDB, saveBytes } from "./hippiusDesktopDB";

/* ── schemas ─────────────────────────────── */

const NOTIFICATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notifications (
    id                       INTEGER PRIMARY KEY,
    userAddress              TEXT NOT NULL,
    notificationType         TEXT,
    notificationSubtype      TEXT,
    notificationTitleText    TEXT,
    notificationDescription  TEXT,
    notificationLinkText     TEXT,
    notificationLink         TEXT,
    isUnread                 INTEGER DEFAULT 1,
    notificationCreationTime INTEGER,
    isDeleted                INTEGER DEFAULT 0,
    deletedAt                INTEGER,
    notificationReleaseNotes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_userAddress ON notifications(userAddress);
  CREATE INDEX IF NOT EXISTS idx_notifications_userAddress_deleted ON notifications(userAddress, isDeleted);
`;

const APP_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_state (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    isFirstTime        INTEGER DEFAULT 1,
    isAboveHalfCredit  INTEGER DEFAULT 0
  );
`;

const NOTIFICATION_PREFERENCES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notification_preferences (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    description TEXT NOT NULL,
    enabled     INTEGER DEFAULT 1
  );
`;

/* ── helpers ────────────────────────────── */

async function getDb(): Promise<initSqlJsType.Database> {
  const db = await initHippiusDesktopDB();

  // Check if notifications table exists and has userAddress column
  const tableExists = db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'`,
  );

  if (tableExists.length > 0) {
    // Table exists, check if userAddress column exists
    const columns = db.exec(`PRAGMA table_info(notifications)`);
    const hasUserAddress = columns[0]?.values.some(
      (col) => col[1] === "userAddress",
    );

    if (!hasUserAddress) {
      // Old schema without userAddress - drop and recreate
      console.log(
        "[NotificationsDB] Old notifications table detected without userAddress column. Dropping and recreating...",
      );
      db.run(`DROP TABLE IF EXISTS notifications`);
      await saveBytes(db.export());
    }
  }

  // Create tables with correct schema
  db.run(NOTIFICATION_SCHEMA);
  db.run(APP_STATE_SCHEMA);
  db.run(NOTIFICATION_PREFERENCES_SCHEMA);

  // Migration for other columns (for users who have userAddress but missing these)
  try {
    db.run(`ALTER TABLE notifications ADD COLUMN isDeleted INTEGER DEFAULT 0`);
  } catch {}
  try {
    db.run(`ALTER TABLE notifications ADD COLUMN deletedAt INTEGER`);
  } catch {}
  try {
    db.run(
      `ALTER TABLE notifications ADD COLUMN notificationReleaseNotes TEXT`,
    );
  } catch {}

  const exists = db.exec(`SELECT 1 FROM app_state WHERE id = 1`);
  if (!exists.length) {
    db.run(`INSERT INTO app_state (id) VALUES (1)`);
  }

  await initNotificationPreferences(db); // may call saveBytes once

  return db;
}

// Initialize notification preferences with default values
async function initNotificationPreferences(db: initSqlJsType.Database) {
  const defaultPrefs = [
    {
      id: "credits",
      label: "Credits",
      description:
        "Sends an alert when fresh credits land in your account or when your balance falls near zero, giving you time to top up before uploads pause.",
    },
    {
      id: "files",
      label: "Files",
      description:
        "Pings you the moment a file sync completes, confirming your data is stored safely and ready whenever you need it.",
    },
  ];

  // Check if preferences exist
  const res = db.exec(`SELECT COUNT(*) FROM notification_preferences`);
  const count = res[0]?.values[0][0] as number;

  // Only initialize if no preferences exist
  if (count === 0) {
    for (const pref of defaultPrefs) {
      db.run(
        `INSERT INTO notification_preferences (id, label, description, enabled) 
         VALUES (?, ?, ?, 1)`,
        [pref.id, pref.label, pref.description],
      );
    }
    await saveBytes(db.export());
  }
}

// Get all notification preferences
export async function getNotificationPreferences() {
  const db = await getDb();
  const res = db.exec(
    `SELECT id, label, description, enabled FROM notification_preferences`,
  );

  if (!res.length) return [];

  return res[0].values.map((row) => ({
    id: row[0] as string,
    label: row[1] as string,
    description: row[2] as string,
    enabled: (row[3] as number) === 1,
  }));
}

// Update all notification preferences at once
export async function updateAllNotificationPreferences(
  prefMap: Record<string, boolean>,
) {
  const db = await getDb();

  // Begin transaction for better performance
  db.exec("BEGIN TRANSACTION");

  try {
    for (const [id, enabled] of Object.entries(prefMap)) {
      db.run(`UPDATE notification_preferences SET enabled = ? WHERE id = ?`, [
        enabled ? 1 : 0,
        id,
      ]);
    }

    db.exec("COMMIT");
    await saveBytes(db.export());
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("Failed to update notification preferences:", error);
    return false;
  }
}

// Get enabled notification types
export async function getEnabledNotificationTypes(): Promise<string[]> {
  const db = await getDb();
  const res = db.exec(
    `SELECT label FROM notification_preferences WHERE enabled = 1`,
  );

  if (!res.length) return [];

  return res[0].values.map((row) => row[0] as string);
}

/* notifications CRUD */

export async function addNotification({
  userAddress,
  notificationType,
  notificationSubtype = "",
  notificationTitleText,
  notificationDescription,
  notificationLinkText,
  notificationLink,
  notificationReleaseNotes = "",
}: {
  userAddress: string;
  notificationType: string;
  notificationSubtype?: string;
  notificationTitleText: string;
  notificationDescription: string;
  notificationLinkText: string;
  notificationLink: string;
  notificationReleaseNotes?: string;
}) {
  const db = await getDb();

  // // Special check for welcome notification - prevent duplicates (including deleted ones)
  // if (notificationSubtype === "Welcome") {
  //   const existing = db.exec(
  //     `SELECT COUNT(*) FROM notifications
  //      WHERE userAddress = ?
  //      AND notificationSubtype = 'Welcome'`,
  //     [userAddress],
  //   );
  //   const count = existing[0]?.values[0][0] as number;
  //   if (count > 0) {
  //     console.log(
  //       `[NotificationsDB] Welcome notification already exists for ${userAddress} (including deleted), skipping`,
  //     );
  //     return;
  //   }
  // }

  db.run(
    `INSERT INTO notifications
       (userAddress, notificationType, notificationSubtype, notificationTitleText,
        notificationDescription, notificationLinkText, notificationLink, notificationReleaseNotes,
        isUnread, notificationCreationTime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, strftime('%s','now')*1000)`,
    [
      userAddress,
      notificationType,
      notificationSubtype,
      notificationTitleText,
      notificationDescription,
      notificationLinkText,
      notificationLink,
      notificationReleaseNotes,
    ],
  );
  await saveBytes(db.export());
  console.log(
    `[NotificationsDB] Added notification for ${userAddress}: ${notificationSubtype || notificationType}`,
  );
}

export async function isFirstTime(): Promise<boolean> {
  const db = await getDb();
  const res = db.exec("SELECT isFirstTime FROM app_state WHERE id = 1");
  return (res[0].values[0][0] as number) === 1;
}
// notificationsDb.ts
export async function creditAlreadyNotified(ts: string): Promise<boolean> {
  const db = await getDb();
  const res = db.exec(
    `SELECT COUNT(*) FROM notifications
       WHERE notificationType = 'Credits'
         AND notificationSubtype = ?
         AND (isDeleted IS NULL OR isDeleted = 0)`,
    [`MintedAccountCredits-${ts}`],
  );
  return (res[0]?.values[0][0] as number) > 0;
}

export async function lowCreditSubtypeExists(
  subtype: string,
): Promise<boolean> {
  const db = await getDb();
  const res = db.exec(
    `SELECT COUNT(*) FROM notifications
       WHERE notificationType = 'Credits'
         AND notificationSubtype = ?
         AND (isDeleted IS NULL OR isDeleted = 0)`,
    [subtype],
  );
  return (res[0]?.values[0][0] as number) > 0;
}

export async function getLastDeletedLowCreditNotification(): Promise<{
  deletedAt: number;
} | null> {
  const db = await getDb();
  const res = db.exec(
    `SELECT deletedAt FROM notifications
       WHERE notificationType = 'Credits'
         AND notificationSubtype LIKE 'LowCreditWarning-%'
         AND isDeleted = 1
         AND deletedAt IS NOT NULL
       ORDER BY deletedAt DESC
       LIMIT 1`,
  );

  if (!res.length || !res[0].values.length) return null;

  return {
    deletedAt: res[0].values[0][0] as number,
  };
}

export async function hasActiveLowCreditNotification(): Promise<boolean> {
  const db = await getDb();
  const res = db.exec(
    `SELECT COUNT(*) FROM notifications
       WHERE notificationType = 'Credits'
         AND notificationSubtype LIKE 'LowCreditWarning-%'
         AND (isDeleted IS NULL OR isDeleted = 0)`,
  );
  return (res[0]?.values[0][0] as number) > 0;
}

export async function markFirstTimeSeen() {
  const db = await getDb();
  db.run("UPDATE app_state SET isFirstTime = 0 WHERE id = 1");
  await saveBytes(db.export());
}
export async function updateIsAboveHalfCredit(isAboveHalfCredit: boolean) {
  const db = await getDb();
  db.run("UPDATE app_state SET isAboveHalfCredit = ? WHERE id = 1", [
    isAboveHalfCredit ? 1 : 0,
  ]);
  await saveBytes(db.export());
}
export async function listNotifications(userAddress: string, limit = 50) {
  const db = await getDb();
  // Merge user-specific notifications with system notifications (like updates)
  const res = db.exec(
    `SELECT *
       FROM notifications
      WHERE (userAddress = ? OR userAddress = 'system')
        AND (isDeleted IS NULL OR isDeleted = 0)
      ORDER BY notificationCreationTime DESC
      LIMIT ?`,
    [userAddress, limit],
  );
  return res[0]?.values ?? [];
}

export async function markRead(id: number) {
  const db = await getDb();
  db.run(`UPDATE notifications SET isUnread = 0 WHERE id = ?`, [id]);
  await saveBytes(db.export());
}

export async function markUnread(id: number) {
  const db = await getDb();
  db.run(`UPDATE notifications SET isUnread = 1 WHERE id = ?`, [id]);
  await saveBytes(db.export());
}

export async function markAllRead(userAddress: string) {
  const db = await getDb();
  // Mark both user-specific and system notifications as read
  db.run(
    `UPDATE notifications SET isUnread = 0 
     WHERE (userAddress = ? OR userAddress = 'system') 
     AND isUnread = 1 AND (isDeleted IS NULL OR isDeleted = 0)`,
    [userAddress],
  );
  await saveBytes(db.export());
  return true;
}

export async function unreadCount(userAddress: string): Promise<number> {
  const db = await getDb();
  // Count both user-specific and system notifications
  const res = db.exec(
    `SELECT COUNT(*) FROM notifications 
     WHERE (userAddress = ? OR userAddress = 'system') 
     AND isUnread = 1 AND (isDeleted IS NULL OR isDeleted = 0)`,
    [userAddress],
  );
  return res[0]?.values[0][0] as number;
}

export async function isAboveHalfCredit(): Promise<boolean> {
  const db = await getDb();
  const res = db.exec("SELECT isAboveHalfCredit FROM app_state WHERE id = 1");
  return (res[0].values[0][0] as number) === 1;
}

export async function hippusVersionNotificationExists(
  version: string,
): Promise<boolean> {
  const db = await getDb();
  // Check for system-wide update notifications
  const res = db.exec(
    `SELECT COUNT(*) FROM notifications
       WHERE userAddress = 'system'
         AND notificationType = 'Hippius'
         AND notificationSubtype = ?
         AND (isDeleted IS NULL OR isDeleted = 0)`,
    [version],
  );
  return (res[0]?.values[0][0] as number) > 0;
}

// Soft delete a single notification
export async function deleteNotification(id: number) {
  const db = await getDb();
  const now = Date.now();
  db.run(`UPDATE notifications SET isDeleted = 1, deletedAt = ? WHERE id = ?`, [
    now,
    id,
  ]);
  await saveBytes(db.export());
  return true;
}

// Soft delete all notifications for a specific user
export async function deleteAllNotifications(userAddress: string) {
  const db = await getDb();
  const now = Date.now();
  db.run(
    `UPDATE notifications SET isDeleted = 1, deletedAt = ? 
     WHERE userAddress = ? AND (isDeleted IS NULL OR isDeleted = 0)`,
    [now, userAddress],
  );
  await saveBytes(db.export());
  return true;
}

// Delete system notification for a specific version (e.g., after update is installed)
export async function deleteSystemNotificationByVersion(version: string) {
  const db = await getDb();
  const now = Date.now();
  db.run(
    `UPDATE notifications SET isDeleted = 1, deletedAt = ? 
     WHERE userAddress = 'system' 
     AND notificationType = 'Hippius' 
     AND notificationSubtype = ? 
     AND (isDeleted IS NULL OR isDeleted = 0)`,
    [now, version],
  );
  await saveBytes(db.export());
  console.log(
    `[NotificationsDB] System notification for version ${version} marked as deleted`,
  );
  return true;
}

// Clear all notifications from database (for testing/reset)
export async function clearAllNotifications() {
  const db = await getDb();
  db.run(`DELETE FROM notifications`);
  await saveBytes(db.export());
  console.log("[NotificationsDB] All notifications cleared from database");
  return true;
}

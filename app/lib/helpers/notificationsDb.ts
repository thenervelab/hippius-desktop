import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import { initHippiusDesktopDB, saveBytes } from "./hippiusDesktopDB";

/* ── schemas ─────────────────────────────── */

const NOTIFICATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notifications (
    id                       INTEGER PRIMARY KEY,
    notificationType         TEXT,
    notificationSubtype      TEXT,
    notificationTitleText    TEXT,
    notificationDescription  TEXT,
    notificationLinkText     TEXT,
    notificationLink         TEXT,
    isUnread                 INTEGER DEFAULT 1,
    notificationCreationTime INTEGER
  );
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

  db.run(NOTIFICATION_SCHEMA);
  db.run(APP_STATE_SCHEMA);
  db.run(NOTIFICATION_PREFERENCES_SCHEMA);

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
        [pref.id, pref.label, pref.description]
      );
    }
    await saveBytes(db.export());
  }
}

// Get all notification preferences
export async function getNotificationPreferences() {
  const db = await getDb();
  const res = db.exec(
    `SELECT id, label, description, enabled FROM notification_preferences`
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
  prefMap: Record<string, boolean>
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
    `SELECT label FROM notification_preferences WHERE enabled = 1`
  );

  if (!res.length) return [];

  return res[0].values.map((row) => row[0] as string);
}

/* notifications CRUD */

export async function addNotification({
  notificationType,
  notificationSubtype = "",
  notificationTitleText,
  notificationDescription,
  notificationLinkText,
  notificationLink,
}: {
  notificationType: string;
  notificationSubtype?: string;
  notificationTitleText: string;
  notificationDescription: string;
  notificationLinkText: string;
  notificationLink: string;
}) {
  const db = await getDb();
  db.run(
    `INSERT INTO notifications
       (notificationType, notificationSubtype, notificationTitleText,
        notificationDescription, notificationLinkText, notificationLink,
        isUnread, notificationCreationTime)
     VALUES (?, ?, ?, ?, ?, ?, 1, strftime('%s','now')*1000)`,
    [
      notificationType,
      notificationSubtype,
      notificationTitleText,
      notificationDescription,
      notificationLinkText,
      notificationLink,
    ]
  );
  await saveBytes(db.export());
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
         AND notificationSubtype = ?`,
    [`MintedAccountCredits-${ts}`]
  );
  return (res[0]?.values[0][0] as number) > 0;
}

export async function lowCreditSubtypeExists(
  subtype: string
): Promise<boolean> {
  const db = await getDb();
  const res = db.exec(
    `SELECT COUNT(*) FROM notifications
       WHERE notificationType = 'Credits'
         AND notificationSubtype = ?`,
    [subtype]
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
export async function listNotifications(limit = 50) {
  const db = await getDb();
  const res = db.exec(
    `SELECT *
       FROM notifications
      ORDER BY notificationCreationTime DESC
      LIMIT ?`,
    [limit]
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

export async function markAllRead() {
  const db = await getDb();
  db.run(`UPDATE notifications SET isUnread = 0 WHERE isUnread = 1`);
  await saveBytes(db.export());
  return true;
}

export async function unreadCount(): Promise<number> {
  const db = await getDb();
  const res = db.exec(`SELECT COUNT(*) FROM notifications WHERE isUnread = 1`);
  return res[0]?.values[0][0] as number;
}

export async function isAboveHalfCredit(): Promise<boolean> {
  const db = await getDb();
  const res = db.exec("SELECT isAboveHalfCredit FROM app_state WHERE id = 1");
  return (res[0].values[0][0] as number) === 1;
}

export async function hippusVersionNotificationExists(
  version: string
): Promise<boolean> {
  const db = await getDb();
  const res = db.exec(
    `SELECT COUNT(*) FROM notifications
       WHERE notificationType = 'Hippius'
         AND notificationSubtype = ?`,
    [version]
  );
  return (res[0]?.values[0][0] as number) > 0;
}

// New: delete a single notification
export async function deleteNotification(id: number) {
  const db = await getDb();
  db.run(`DELETE FROM notifications WHERE id = ?`, [id]);
  await saveBytes(db.export());
  return true;
}

// New: delete all notifications
export async function deleteAllNotifications() {
  const db = await getDb();
  db.run(`DELETE FROM notifications`);
  await saveBytes(db.export());
  return true;
}

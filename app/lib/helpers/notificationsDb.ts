import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import { initWalletDb, saveBytes } from "./walletDb";

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

/* ── helpers ─────────────────────────────── */

async function getDb(): Promise<initSqlJsType.Database> {
  const db = await initWalletDb(); // same file as wallet
  db.run(NOTIFICATION_SCHEMA);
  db.run(APP_STATE_SCHEMA);

  /* make sure row #1 exists */
  const exists = db.exec(`SELECT 1 FROM app_state WHERE id = 1`);
  if (!exists.length) db.run(`INSERT INTO app_state (id) VALUES (1)`);

  return db;
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

export async function markFirstTimeSeen() {
  const db = await getDb();
  db.run("UPDATE app_state SET isFirstTime = 0 WHERE id = 1");
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

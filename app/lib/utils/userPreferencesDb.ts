import { initWalletDb, saveBytes } from "../helpers/walletDb";

type ViewMode = "list" | "card";

interface UserPreferences {
    viewMode?: ViewMode;
}

const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_preferences (
    preference_key TEXT PRIMARY KEY,
    preference_value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

async function ensurePreferencesTable() {
    const db = await initWalletDb();
    db.run(TABLE_SCHEMA);
    await saveBytes(db.export());
    return db;
}

export async function getViewModePreference(): Promise<ViewMode> {
    try {
        const db = await ensurePreferencesTable();

        const result = db.exec(
            "SELECT preference_value FROM user_preferences WHERE preference_key = 'file_view_preferences'"
        );

        if (!result.length || !result[0]?.values.length) {
            return "list";
        }

        try {
            const rawValue = result[0].values[0][0] as string;
            const parsedValue = JSON.parse(rawValue) as UserPreferences;
            return parsedValue.viewMode || "list";
        } catch (error) {
            console.error("Failed to parse view mode preference:", error);
            return "list";
        }
    } catch (error) {
        console.error("Failed to get view mode preference:", error);
        return "list";
    }
}

export async function saveViewModePreference(viewMode: ViewMode): Promise<void> {
    try {
        const db = await ensurePreferencesTable();

        const preferenceValue = JSON.stringify({ viewMode });

        const existing = db.exec(
            "SELECT preference_key FROM user_preferences WHERE preference_key = 'file_view_preferences'"
        );

        if (existing.length > 0 && existing[0]?.values.length > 0) {
            db.run(
                "UPDATE user_preferences SET preference_value = ?, updated_at = ? WHERE preference_key = ?",
                [preferenceValue, Date.now(), 'file_view_preferences']
            );
        } else {
            db.run(
                "INSERT INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, ?, ?)",
                ['file_view_preferences', preferenceValue, Date.now()]
            );
        }

        await saveBytes(db.export());
    } catch (error) {
        console.error("Failed to save view mode preference:", error);
    }
}

export async function getUserPreference<T = unknown>(key: string): Promise<T | null> {
    try {
        const db = await ensurePreferencesTable();

        const result = db.exec(
            `SELECT preference_value FROM user_preferences WHERE preference_key = '${key}'`
        );

        if (!result.length || !result[0]?.values.length) {
            return null;
        }

        try {
            const rawValue = result[0].values[0][0] as string;
            return JSON.parse(rawValue) as T;
        } catch (error) {
            console.error(`Failed to parse preference for key ${key}:`, error);
            return null;
        }
    } catch (error) {
        console.error(`Failed to get preference for key ${key}:`, error);
        return null;
    }
}

export async function saveUserPreference<T = unknown>(key: string, value: T): Promise<void> {
    try {
        const db = await ensurePreferencesTable();

        const preferenceValue = JSON.stringify(value);

        const existing = db.exec(
            `SELECT preference_key FROM user_preferences WHERE preference_key = '${key}'`
        );

        if (existing.length > 0 && existing[0]?.values.length > 0) {
            db.run(
                "UPDATE user_preferences SET preference_value = ?, updated_at = ? WHERE preference_key = ?",
                [preferenceValue, Date.now(), key]
            );
        } else {
            db.run(
                "INSERT INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, ?, ?)",
                [key, preferenceValue, Date.now()]
            );
        }

        await saveBytes(db.export());
    } catch (error) {
        console.error(`Failed to save preference for key ${key}:`, error);
    }
}

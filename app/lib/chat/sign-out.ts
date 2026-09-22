/**
 * Copy and URL helpers for signing out of chat. Pure: the account menu, the
 * settings dialog and the route screens all read from here so every entry
 * point says the same thing (mirrors the console's `ChatSettingsDialog`
 * exports of the same names).
 */

/** Heading of the confirm dialog shown before a sign-out. */
export const CHAT_SIGN_OUT_HEADING = "Sign out of chat on this device?";

/** Body of that dialog: what is revoked, what is deleted, what survives. */
export const CHAT_SIGN_OUT_CONFIRM =
  "This device's chat session is revoked and its local message cache, keys and drafts are deleted. Messages in encrypted rooms stay recoverable with your mnemonic.";

/**
 * Where the identity provider lists this account's sessions. "Sign out
 * everywhere" is an IdP action — a Matrix client cannot log the other
 * devices out itself — so the app opens that page in the system browser.
 * MSC2965 names the action; `null` when the server advertises no account
 * management URL or an unparsable one.
 */
export function sessionsListUrl(accountManagementUri: string | undefined | null): string | null {
  if (!accountManagementUri) return null;
  try {
    const url = new URL(accountManagementUri);
    url.searchParams.set("action", "org.matrix.sessions_list");
    return url.toString();
  } catch {
    return null;
  }
}

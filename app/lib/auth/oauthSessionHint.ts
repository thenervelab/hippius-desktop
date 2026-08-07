import type { OAuthSession } from "@/app/lib/types/oAuth";

export const OAUTH_SESSION_KEY = "hippius_oauth_session";
export const OAUTH_SESSION_EXPIRY_KEY = "hippius_oauth_session_expiry";

/**
 * The OAuth session as it is allowed to touch disk: everything except the
 * bearer token.
 */
export type OAuthSessionHint = Omit<OAuthSession, "token">;

/**
 * Strip the bearer token from a session object.
 *
 * Rust owns session restoration and reads the `auth_session` row, so the
 * localStorage copy is only a *hint* — it lets `/auth/callback` and
 * `DeepLinkListener` answer "is someone signed in?" synchronously, before
 * the `restore_session` IPC resolves. Neither reads the token, and keeping
 * a live 30-day bearer token in Web Storage is exactly what OWASP warns
 * against (audit S-4).
 */
export function toOAuthSessionHint(session: OAuthSession): OAuthSessionHint {
  // Deliberately an allowlist rather than `{...session}` minus `token`: a
  // field added to `OAuthSession` later must not start landing on disk
  // just because nobody remembered this funnel. If the new field belongs
  // in the hint, adding it here is a one-line, reviewable decision — and
  // if it is another secret, the default is that it never leaks.
  return {
    userId: session.userId,
    username: session.username,
    email: session.email,
    substrateAddress: session.substrateAddress,
    provider: session.provider,
    expiresAt: session.expiresAt,
    isNew: session.isNew,
  };
}

/** Persist the token-free hint for the synchronous boot checks. */
export function persistOAuthSessionHint(session: OAuthSession): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    OAUTH_SESSION_KEY,
    JSON.stringify(toOAuthSessionHint(session)),
  );
  localStorage.setItem(OAUTH_SESSION_EXPIRY_KEY, session.expiresAt);
}

export function clearOAuthSessionHint(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(OAUTH_SESSION_KEY);
  localStorage.removeItem(OAUTH_SESSION_EXPIRY_KEY);
}

/**
 * Remove a bearer token written by a pre-S-4 build.
 *
 * Ignoring the legacy value is not enough — it was already written to
 * disk, so it has to be actively deleted. Runs on every boot; rewrites the
 * entry in place (preserving the hint) so the synchronous checks that
 * depend on it keep working. Returns true when a token was found and
 * scrubbed, which is what the test asserts on.
 */
export function scrubLegacyOAuthToken(): boolean {
  if (typeof window === "undefined") return false;
  const raw = localStorage.getItem(OAUTH_SESSION_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!("token" in parsed)) return false;
    delete parsed.token;
    localStorage.setItem(OAUTH_SESSION_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    // Unparseable entry: it cannot serve as a hint and may still hold a
    // token, so drop it entirely.
    localStorage.removeItem(OAUTH_SESSION_KEY);
    return true;
  }
}

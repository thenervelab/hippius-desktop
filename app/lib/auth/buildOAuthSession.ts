import type { OAuthSession } from "@/app/lib/types/oAuth";

/** Result from Rust login_with_mnemonic command. */
export interface LoginResult {
  substrateAddress: string;
  ethAddress: string;
  userId: number | string | null;
  username: string;
  provider: string;
  token: string;
  tokenExpiry: number;
  isNew: boolean;
}

/**
 * Build an OAuthSession-compatible object from a login/unlock result.
 *
 * Normalizes the two fields the Rust result leaves loose: a non-numeric
 * `userId` (string or null from older sessions) collapses to `0`, and a
 * missing `provider` falls back to `providerOverride` then `"mnemonic"`.
 * `tokenExpiry` (epoch ms) is rendered to ISO-8601 for the session store.
 */
export function buildOAuthSession(
  result: LoginResult,
  providerOverride?: string
): OAuthSession {
  return {
    token: result.token,
    userId: typeof result.userId === "number" ? result.userId : 0,
    username: result.username,
    provider: (providerOverride ?? result.provider ?? "mnemonic") as OAuthSession["provider"],
    expiresAt: new Date(result.tokenExpiry).toISOString(),
    substrateAddress: result.substrateAddress,
    isNew: result.isNew,
  };
}

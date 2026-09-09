import type { OAuthSession } from "@/app/lib/types/oAuth";

/** Middle-truncated SS58, matching the console's own card. */
export function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(address.length - 8)}`;
}

export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  apple: "Apple",
};

export interface AccountIdentity {
  /** What the collapsed card shows as its primary line. */
  primary: string;
  /** Name at the top of the open menu. */
  menuName: string;
  /** Email under that name, when it says something the name does not. */
  menuEmail?: string;
  /** "Google" / "GitHub" / "Apple", or undefined for a mnemonic account. */
  providerLabel?: string;
  /** Whether this account has a human sign-in identity at all. */
  isOAuthAccount: boolean;
  /** The middle-truncated address, shown on its own row. */
  truncatedAddress: string;
}

/**
 * Who the account belongs to, for the sidebar card and its menu.
 *
 * Mirrors the console's resolution so one account is not described two
 * different ways by two clients:
 *
 * - GitHub signs in as a handle, so it reads `@handle`; Google and Apple
 *   sign in with an email, so that is what they show.
 * - The card's primary line is that sign-in identity rather than the SS58.
 *   Users were mistaking the SS58 for a deposit address and sending tokens
 *   to it; it stays reachable on its own row in the menu.
 * - A mnemonic account has no sign-in identity, so it keeps the address.
 * - The menu's email is dropped when it merely repeats the name above it.
 */
export function resolveAccountIdentity(
  session: OAuthSession | null | undefined,
  address: string,
): AccountIdentity {
  const truncatedAddress = truncateAddress(address);
  const provider = session?.provider;
  const isOAuthAccount = Boolean(provider) && provider !== "mnemonic";

  const signInHandle =
    provider === "github"
      ? session?.username
        ? `@${session.username}`
        : undefined
      : session?.email;
  const displayName = session?.username || undefined;

  const menuName = displayName || signInHandle || truncatedAddress;
  const email = session?.email;

  return {
    primary: isOAuthAccount
      ? signInHandle || displayName || truncatedAddress
      : truncatedAddress,
    menuName,
    ...(email && email !== menuName ? { menuEmail: email } : {}),
    ...(provider && PROVIDER_LABELS[provider]
      ? { providerLabel: PROVIDER_LABELS[provider] }
      : {}),
    isOAuthAccount,
    truncatedAddress,
  };
}

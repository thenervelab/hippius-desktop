import type { OAuthSession } from "@/app/lib/types/oAuth";
import { displayEmail } from "@/lib/utils/displayEmail";

/**
 * Middle-truncated SS58, matching the console's own card. For words that are
 * not drawn in a fixed box (an accessible name); a drawn address goes through
 * `MiddleTruncate`, which shortens it to the width it actually has.
 */
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
  /**
   * What the sidebar card shows as its primary line, whole. The card
   * shortens it in the middle to the rail's width (`MiddleTruncate`): an
   * email keeps its domain, an address both ends. There is no character
   * budget here on purpose: the rail's width changes with the window, the
   * zoom and the font, so a count was clipped again from the end, taking the
   * ".com" it existed to protect.
   */
  primary: string;
  /** Name at the top of the open menu, whole (shortened where it is drawn). */
  menuName: string;
  /** Email under that name, when it says something the name does not. */
  menuEmail?: string;
  /** "Google" / "GitHub" / "Apple", or undefined for a mnemonic account. */
  providerLabel?: string;
  /** Whether this account has a human sign-in identity at all. */
  isOAuthAccount: boolean;
  /** The full address, shown on its own row and shortened there. */
  address: string;
  /** The address shortened by a fixed count, for an accessible name. */
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
 * - A system placeholder email (`@hippius.local`) counts as no email, so
 *   the card falls back to the name, then the address.
 */
export function resolveAccountIdentity(
  session: OAuthSession | null | undefined,
  address: string,
): AccountIdentity {
  const truncatedAddress = truncateAddress(address);
  const provider = session?.provider;
  const isOAuthAccount = Boolean(provider) && provider !== "mnemonic";

  const email = displayEmail(session?.email);
  const signInHandle =
    provider === "github"
      ? session?.username
        ? `@${session.username}`
        : undefined
      : email;
  const displayName = session?.username || undefined;

  const menuName = displayName || signInHandle || address;

  const primary = isOAuthAccount ? signInHandle || displayName || address : address;

  return {
    primary,
    menuName,
    ...(email && email !== menuName ? { menuEmail: email } : {}),
    ...(provider && PROVIDER_LABELS[provider]
      ? { providerLabel: PROVIDER_LABELS[provider] }
      : {}),
    isOAuthAccount,
    address,
    truncatedAddress,
  };
}

import type { OAuthSession } from "@/app/lib/types/oAuth";

/** Middle-truncated SS58, matching the console's own card. */
export function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(address.length - 8)}`;
}

/** An identity split so the shortening can only land in the head. */
export interface IdentityParts {
  /** The part allowed to give way. */
  head: string;
  /** The part that must always stay legible; empty when there is none. */
  tail: string;
}

/**
 * Split an identity into the part that may be shortened and the part that
 * must not be.
 *
 * There is no character budget here on purpose. Every previous attempt
 * picked a number, and a number cannot be right: the rail's width changes
 * with the window, the zoom and the font, so a string that fits one
 * moment is clipped the next — and the clip landed on the END, taking the
 * ".com" the shortening existed to protect. Two shortenings fighting each
 * other, one of them blind.
 *
 * Instead the browser measures, and this only decides WHERE it is allowed
 * to cut. For an email the tail is the TLD, so:
 *
 *   plenty of room  →  ahmadraosanawarali@gmail.com
 *   less room       →  ahmadraosanawar….com
 *   very little     →  ahmad….com
 *
 * The host sits at the end of the head, so it is given up before the name
 * is — "@gmail" says nothing about which account this is, while the name
 * is the whole of what does.
 *
 * Anything with no "@" (a handle, an SS58) has no part worth pinning and
 * gives way from its end like ordinary text.
 */
export function splitIdentity(value: string): IdentityParts {
  const at = value.lastIndexOf("@");
  const dot = value.lastIndexOf(".");
  // `dot > at + 1` requires a host between the two, so "a@.com" is not
  // mistaken for a domain and left with an empty head.
  if (at > 0 && dot > at + 1) {
    return { head: value.slice(0, dot), tail: value.slice(dot) };
  }
  return { head: value, tail: "" };
}

export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  apple: "Apple",
};

export interface AccountIdentity {
  /**
   * What the sidebar card shows as its primary line, split so the rail
   * can shorten it without losing the end — see {@link splitIdentity}.
   */
  primary: IdentityParts;
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

  const primary = isOAuthAccount
    ? signInHandle || displayName || truncatedAddress
    : truncatedAddress;

  return {
    primary: splitIdentity(primary),
    menuName,
    ...(email && email !== menuName ? { menuEmail: email } : {}),
    ...(provider && PROVIDER_LABELS[provider]
      ? { providerLabel: PROVIDER_LABELS[provider] }
      : {}),
    isOAuthAccount,
    truncatedAddress,
  };
}

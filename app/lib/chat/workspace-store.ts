/**
 * The little the workspace feature persists in the webview: the last
 * active workspace per account and the collapsed categories of each
 * workspace (localStorage, survives relaunches). Presentation state only —
 * Space ids the server already knows — so it stays out of the Rust
 * preference table, like the theme.
 *
 * Ported from the console's `lib/chat/workspace-store.ts`. The console also
 * parks an invite-link token in sessionStorage across its browser sign-in;
 * the desktop has no URL to land on, so that part is not here (invite links
 * are pasted into the "Join a workspace" dialog instead).
 */

/** localStorage key prefix for the last active workspace, per account: `${prefix}${userId}` -> Space id. */
export const CHAT_ACTIVE_WORKSPACE_PREFIX = "hippius-chat-workspace:";
/** localStorage key prefix for the collapsed categories of a workspace: `<prefix><userId>:<spaceId>`. */
export const CHAT_COLLAPSED_CATEGORIES_PREFIX = "hippius-chat-collapsed-categories:";

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadActiveWorkspace(userId: string): string | null {
  const value = safeStorage()?.getItem(CHAT_ACTIVE_WORKSPACE_PREFIX + userId);
  return value && value.startsWith("!") ? value : null;
}

export function saveActiveWorkspace(userId: string, spaceId: string | null): void {
  const storage = safeStorage();
  if (!storage) return;
  const key = CHAT_ACTIVE_WORKSPACE_PREFIX + userId;
  if (spaceId) storage.setItem(key, spaceId);
  else storage.removeItem(key);
}

/**
 * Pick the workspace to open: the remembered one if still joined, else the
 * first. `null` when there is none (onboarding).
 */
export function resolveActiveWorkspace(remembered: string | null, available: readonly { id: string }[]): string | null {
  if (available.length === 0) return null;
  if (remembered && available.some((w) => w.id === remembered)) return remembered;
  return available[0].id;
}

// ------------------------------------------------ collapsed categories --

/**
 * Which categories of a workspace the account has folded in the sidebar
 * (per account and workspace). The set is of category Space ids; the
 * sidebar's own top-level sections are not stored here.
 */
export function loadCollapsedCategories(userId: string, spaceId: string): Set<string> {
  const raw = safeStorage()?.getItem(`${CHAT_COLLAPSED_CATEGORIES_PREFIX}${userId}:${spaceId}`);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.startsWith("!")) : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedCategories(userId: string, spaceId: string, collapsed: ReadonlySet<string>): void {
  const storage = safeStorage();
  if (!storage) return;
  const key = `${CHAT_COLLAPSED_CATEGORIES_PREFIX}${userId}:${spaceId}`;
  if (collapsed.size === 0) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify([...collapsed].sort()));
}

// ------------------------------------------------------ invite links --

/** Loose shape check on a pasted invite token before it is sent anywhere. */
export function isPlausibleJoinToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(token);
}

/**
 * The token in a pasted invite: a bare token, or the console's
 * `https://…/chat/join/<token>` link. `null` when neither.
 */
export function parseJoinInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isPlausibleJoinToken(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split("/").filter(Boolean);
    const joinIndex = segments.indexOf("join");
    if (joinIndex < 0 || joinIndex === segments.length - 1) return null;
    const token = decodeURIComponent(segments[joinIndex + 1]);
    return isPlausibleJoinToken(token) ? token : null;
  } catch {
    return null;
  }
}

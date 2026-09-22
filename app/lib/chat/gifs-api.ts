/**
 * The GIF search proxy as the picker sees it.
 *
 * Rust (`chat::backend`) owns the HTTP: it carries the Hippius API token,
 * clamps the page size and maps the two statuses the picker renders
 * differently into a `kind`-tagged `GifFetch`. This module turns that tag
 * back into the exceptions the picker's error path branches on, so the
 * component logic is the console's line for line:
 *
 *   - `disabled`  (503, `gifs_not_configured`) → `GifsUnavailableError`;
 *     the button greys out for the session and the picker says why.
 *   - `throttled` (429) → `GifsThrottledError`; retryable, inline message.
 *   - anything else rejects the invoke with a plain `AppError` and is shown
 *     as it comes, with Retry.
 */

import {
  type GifFetch,
  type GifPage,
  chatGifsFeatured,
  chatGifsSearch,
} from "@/lib/tauri/chat";
import { errorMessage } from "@/lib/utils/errorUtils";

export type {
  GifMedia,
  GifMp4,
  GifPage,
  GifResult,
  GifSizedMedia,
} from "@/lib/tauri/chat";

export const GIF_PAGE_SIZE = 24;

/** The backend's `code` for a deployment without a provider key. */
export const GIFS_NOT_CONFIGURED = "gifs_not_configured";
/** Shown on the greyed-out button and inside the picker on a 503. */
export const GIFS_DISABLED_MESSAGE = "GIFs are not enabled on this deployment";
export const GIFS_THROTTLED_MESSAGE = "Too many searches — give it a moment.";

/** The deployment has no provider key: the picker stays disabled. */
export class GifsUnavailableError extends Error {
  code: string | null;

  constructor(code: string | null) {
    super(GIFS_DISABLED_MESSAGE);
    this.name = "GifsUnavailableError";
    this.code = code;
  }
}

/** Per-user throttle: try again shortly. */
export class GifsThrottledError extends Error {
  constructor() {
    super(GIFS_THROTTLED_MESSAGE);
    this.name = "GifsThrottledError";
  }
}

export function isGifsUnavailable(
  error: unknown,
): error is GifsUnavailableError {
  return error instanceof GifsUnavailableError;
}

/** The kind-tagged Rust answer → a page, or the exception the picker branches on. */
export function unwrapGifFetch(fetch: GifFetch): GifPage {
  switch (fetch.kind) {
    case "page":
      return {
        results: fetch.results,
        next: fetch.next,
        attribution: fetch.attribution,
      };
    case "disabled":
      throw new GifsUnavailableError(fetch.code);
    case "throttled":
      throw new GifsThrottledError();
  }
}

/** `Accept-Language` for the proxy; `null` outside a browser. */
function locale(): string | null {
  return typeof navigator !== "undefined" && navigator.language
    ? navigator.language
    : null;
}

export interface GifQueryOptions {
  pos?: string | null;
  limit?: number;
}

export async function searchGifs(
  q: string,
  { pos, limit }: GifQueryOptions = {},
): Promise<GifPage> {
  return unwrapGifFetch(
    await chatGifsSearch(q, { pos, limit, locale: locale() }),
  );
}

export async function featuredGifs({
  pos,
  limit,
}: GifQueryOptions = {}): Promise<GifPage> {
  return unwrapGifFetch(
    await chatGifsFeatured({ pos, limit, locale: locale() }),
  );
}

/**
 * Is the proxy configured on this deployment? One cheap `featured` call
 * (`limit=1`). `false` only on the backend's explicit 503; any other failure
 * (network, 429, expired session) rejects so the caller can leave the
 * question open and try again later rather than greying the button out on
 * a transient error.
 */
export async function probeGifsAvailability(): Promise<boolean> {
  try {
    await featuredGifs({ limit: 1 });
    return true;
  } catch (error) {
    if (isGifsUnavailable(error)) return false;
    throw error;
  }
}

/** User-facing message for a failed page load. */
export function gifErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const message = errorMessage(error);
  return message && message !== "undefined" && message !== "[object Object]"
    ? message
    : "Could not load GIFs";
}

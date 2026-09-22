/**
 * The shortest text term a server-side file search will match.
 *
 * The HCFS server answers a `q` of one or two characters with an empty page
 * rather than an error, so sending one looks exactly like "no files match".
 * Both server-backed searches (the sidebar palette and the drive-scoped
 * search) use this to show a "keep typing" hint instead of that false
 * negative.
 *
 * The rule itself is enforced in Rust (`MIN_QUERY_CHARS` in
 * `src-tauri/src/sync/fileops/recent_uploads.rs`), which never puts a shorter
 * term on the wire. This copy only decides what to show; the shared fixture
 * `src-tauri/tests/fixtures/search_term_cases.json` keeps the two in step.
 *
 * Local searches (disk walk, in-memory filter) have no such minimum and do
 * not use this.
 */
export const MIN_SEARCH_TERM_LENGTH = 3;

/** Hint shown while a typed term is still below the minimum. */
export const SEARCH_TERM_TOO_SHORT_HINT = `Type at least ${MIN_SEARCH_TERM_LENGTH} characters to search.`;

/**
 * The term to send to a server-side search, or `null` when there is none to
 * send (nothing typed, or fewer than {@link MIN_SEARCH_TERM_LENGTH}
 * characters).
 *
 * Length is counted in code points, not UTF-16 units, to match Rust's
 * `chars().count()`: two astral characters are four units long and would
 * otherwise pass here while Rust dropped them.
 */
export function serverSearchTerm(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";

  if (Array.from(trimmed).length < MIN_SEARCH_TERM_LENGTH) {
    return null;
  }

  return trimmed;
}

/** True when something was typed, but not enough of it to search for. */
export function isSearchTermTooShort(raw: string | null | undefined): boolean {
  const trimmed = raw?.trim() ?? "";

  return trimmed.length > 0 && serverSearchTerm(trimmed) === null;
}

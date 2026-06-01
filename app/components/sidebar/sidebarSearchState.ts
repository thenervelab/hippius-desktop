/**
 * Pure view-state resolver for the sidebar search palette.
 *
 * The palette draws from two data sources — the cross-drive search
 * (`useGlobalRecursiveFileSearch`) once the user types, and the "last
 * uploads" list (`useRecentFiles`) shown while the query is empty — each
 * with its own loading and empty states. Centralising the branching here
 * keeps `SidebarSearchModal` declarative (it maps one enum to one rendered
 * block) and lets the precedence rules be unit-tested without mounting React.
 */
export type SidebarSearchView =
  | "recent-loading" // empty query, recent uploads loading with nothing cached
  | "recent" // empty query, show the recent-uploads list
  | "recent-empty" // empty query, recent uploads settled but empty
  | "skeleton" // active query, fetching, no results yet
  | "results" // active query, has results to show
  | "no-results"; // active query, settled with zero matches

export interface SidebarSearchViewInput {
  /** True when the trimmed query is non-empty. */
  hasQuery: boolean;
  /** True while the search IPC is in flight for the current query. */
  isFetching: boolean;
  /** Number of search results currently available. */
  resultCount: number;
  /** True while the recent-uploads query is loading with nothing cached. */
  recentLoading: boolean;
  /** Number of recent-upload entries currently available. */
  recentCount: number;
}

/**
 * Resolve which block the palette should render.
 *
 * Precedence mirrors the old dropdown: already-available rows win over a
 * loading state (so a background refetch never blanks the list), and the
 * "empty" message only appears once the relevant query has settled.
 */
export function getSidebarSearchView(
  input: SidebarSearchViewInput,
): SidebarSearchView {
  const { hasQuery, isFetching, resultCount, recentLoading, recentCount } =
    input;

  if (!hasQuery) {
    if (recentCount > 0) return "recent";
    if (recentLoading) return "recent-loading";
    return "recent-empty";
  }

  if (resultCount > 0) return "results";
  if (isFetching) return "skeleton";
  return "no-results";
}

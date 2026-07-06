/**
 * Decide whether a loading skeleton should show for a query's current loading
 * state, given whether that query has ever settled before.
 *
 * A skeleton must show ONLY until its query FIRST settles (goes non-loading),
 * then never again — even if the query's `isLoading`/`isFetching` later
 * OSCILLATES. Two ways that oscillation arises in this app:
 *
 *   • a `staleTime: 0` + `refetchInterval` query against an endpoint that lags
 *     or stays pending (e.g. `useDriveStorageStats`) — its `isLoading` flips
 *     true↔false on every poll and never reaches a stable settled state;
 *   • a card that deliberately gates its skeleton on `isFetching`, which goes
 *     true on every refetch (initial AND background/manual).
 *
 * Wiring either into a CHART's skeleton makes the chart unmount→remount on each
 * tick and replay its entrance animation (the reported "swoop every ~5s"), plus
 * flashes the skeleton placeholders. Latching to the first settle decouples the
 * visible card from the refetch cadence: the entrance animation then plays only
 * on a real mount (page transition) or a user range switch.
 *
 * Pure so the latch is unit-testable without rendering the chart.
 *
 * @param settled  whether this query has already settled at least once
 * @param isLoading the query's current `isLoading` (or whatever loading flag
 *                  gates the skeleton)
 * @returns the next `settled` flag (monotonic: false→true only) and whether to
 *          show the skeleton right now
 */
export function nextSkeletonState(
  settled: boolean,
  isLoading: boolean,
): { settled: boolean; showSkeleton: boolean } {
  return {
    settled: settled || !isLoading,
    // Use the INCOMING settled: once it has ever settled, never show again.
    showSkeleton: isLoading && !settled,
  };
}

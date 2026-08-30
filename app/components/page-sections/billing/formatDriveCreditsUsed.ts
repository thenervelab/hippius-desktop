/** Headline for Drive credit usage. H-083: 0.0038 HIP must not become "0.00". */
export function formatDriveCreditsUsed(usedTotal: number): string {
  if (usedTotal >= 1e6) return `${(usedTotal / 1e6).toFixed(1)}M`;
  if (usedTotal >= 1e3) return `${(usedTotal / 1e3).toFixed(1)}K`;
  if (usedTotal > 0 && usedTotal < 0.01) return usedTotal.toFixed(4);
  return usedTotal.toFixed(2);
}

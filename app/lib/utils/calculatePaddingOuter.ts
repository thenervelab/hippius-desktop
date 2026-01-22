/**
 * Calculates paddingOuter for a band scale based on the number of x labels.
 */
export function calculatePaddingOuter(xLabelsLength: number): number {
  return xLabelsLength > 0 ? (xLabelsLength / 3) * 0.1 : 0;
}

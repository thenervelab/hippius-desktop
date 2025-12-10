/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Calculates the delta (difference) between consecutive entries for multiple properties.
 * Uses BigInt to handle large values without precision loss.
 * This is the reverse of calculateCumulative - it "decumulates" cumulative data.
 *
 * Important: This function assumes data is in reverse chronological order (newest first)
 * and will reverse it, calculate deltas from oldest to newest, then reverse back.
 *
 * For each entry, it calculates: current_value - previous_value
 * The first entry (oldest) will have its original value as the delta.
 *
 * @param data - Array of objects containing the properties to calculate deltas for (newest first)
 * @param propKeys - One or more property names to calculate deltas for (up to 4)
 * @returns A new array with delta values for the specified properties (same order as input)
 *
 * @example
 * calculateDelta(data, "total_credits_minted")
 * calculateDelta(data, "total_credits_minted", "total_purchases")
 */
export function calculateDelta<T extends Record<string, any>>(
  data: T[],
  ...propKeys: (keyof T)[]
): T[] {
  if (!data || data.length === 0) return data;
  if (!propKeys || propKeys.length === 0) return data;

  // Reverse the array to process from oldest to newest
  const reversed = [...data].reverse();

  // Store previous values for each property
  const previousValues = new Map<keyof T, bigint>();
  const originalTypes = new Map<keyof T, "string" | "number">();

  // Initialize all properties with null (no previous value yet)
  propKeys.forEach((key) => {
    previousValues.set(key, BigInt(0));
  });

  let isFirstItem = true;

  const result = reversed.map((item) => {
    const newItem = { ...item };

    // Process all properties in a single iteration
    propKeys.forEach((propKey) => {
      try {
        const value = item[propKey];

        // Store the original type on first encounter
        if (
          !originalTypes.has(propKey) &&
          value !== undefined &&
          value !== null
        ) {
          if (typeof value === "string") {
            originalTypes.set(propKey, "string");
          } else if (typeof value === "number") {
            originalTypes.set(propKey, "number");
          }
        }

        // Convert the value to BigInt
        let bigIntValue: bigint;

        if (typeof value === "string") {
          // Remove commas if present
          const cleaned = value.replace(/,/g, "");
          bigIntValue = BigInt(cleaned);
        } else if (typeof value === "number") {
          bigIntValue = BigInt(Math.floor(value));
        } else if (typeof value === "bigint") {
          bigIntValue = value;
        } else {
          // If value is not convertible, use 0
          bigIntValue = BigInt(0);
        }

        // Calculate delta: current - previous
        const previousValue = previousValues.get(propKey) || BigInt(0);
        let delta: bigint;

        if (isFirstItem) {
          // First item (oldest): delta is the value itself
          delta = bigIntValue;
        } else {
          // Subsequent items: delta = current - previous
          delta = bigIntValue - previousValue;
        }

        // Update previous value for next iteration
        previousValues.set(propKey, bigIntValue);

        // Convert back to original type
        const originalType = originalTypes.get(propKey);
        if (originalType === "number") {
          // Return as number if original was number
          newItem[propKey] = Number(delta) as T[keyof T];
        } else {
          // Return as string if original was string or default
          newItem[propKey] = delta.toString() as T[keyof T];
        }
      } catch (error) {
        console.error(
          `Error calculating delta for property "${String(propKey)}":`,
          error
        );
        // On error, set delta to 0
        const originalType = originalTypes.get(propKey);
        if (originalType === "number") {
          newItem[propKey] = 0 as T[keyof T];
        } else {
          newItem[propKey] = "0" as T[keyof T];
        }
      }
    });

    isFirstItem = false;
    return newItem;
  });

  // Reverse back to original order (newest first)
  return result.reverse();
}

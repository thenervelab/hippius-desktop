import { MarketplaceCreditObject } from "@/lib/hooks/api/useMarketplaceCredits";
import { Account } from "@/lib/types";


/**
 * Converts raw credit value from API (smallest unit) to human-readable credits
 * Example: "1000000000000000000" → 1.0
 */
function convertCredits(rawValue: string): bigint {
  try {
    const valueBigInt = BigInt(rawValue);
    // Divide by 10^18 to get the actual credit value
    return valueBigInt;
  } catch {
    return BigInt(0);
  }
}

/**
 * Generates a continuous date range between two dates
 */
function generateDateRange(startDate: Date, endDate: Date): string[] {
  const dates: string[] = [];
  // Normalize both dates to start of day in local timezone
  const current = new Date(startDate);
  current.setHours(0, 0, 0, 0);

  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);

  while (current <= end) {
    // Format date as YYYY-MM-DD in local timezone (not UTC)
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, '0');
    const day = String(current.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);

    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Transforms marketplace credits data into cumulative running totals
 * Day 1: 1 credit → shows 1
 * Day 2: 2 more credits → shows 3 (cumulative)
 * Day 3: 0 credits → shows 3 (stays same, fills gap)
 * This creates a monotonically increasing cumulative line
 */
export function transformMarketplaceCreditsToAccounts(
  credits: MarketplaceCreditObject[]
): Account[] {
  if (!credits || credits.length === 0) return [];

  // Step 1: Group and sum credits by date (daily total)
  // Convert each credit value by dividing by 10^18
  const dailyCredits = credits.reduce(
    (acc, credit) => {
      // Parse date in local timezone (not UTC)
      const creditDate = new Date(credit.date);
      const year = creditDate.getFullYear();
      const month = String(creditDate.getMonth() + 1).padStart(2, '0');
      const day = String(creditDate.getDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${day}`;

      const convertedAmount = convertCredits(credit.amount);

      if (!acc[dateKey]) {
        acc[dateKey] = {
          amount: BigInt(0),
          timestamp: credit.date,
        };
      }

      acc[dateKey].amount += convertedAmount;
      return acc;
    },
    {} as Record<string, { amount: bigint; timestamp: string }>
  );

  const sortedDates = Object.keys(dailyCredits).sort();
  if (sortedDates.length === 0) return [];

  const minDate = new Date(sortedDates[0]);
  const maxDate = new Date(sortedDates[sortedDates.length - 1]);

  // Step 3: Generate continuous date range (every day)
  const continuousDateRange = generateDateRange(minDate, maxDate);

  // Step 4: Build cumulative data with gaps filled
  const result: Account[] = [];
  let cumulativeBalance = BigInt(0);

  for (const dateStr of continuousDateRange) {
    if (dailyCredits[dateStr]) {
      // Add today's credits to cumulative total
      cumulativeBalance += dailyCredits[dateStr].amount;
    }
    // If no credits today, cumulativeBalance stays the same (gap is filled)

    result.push({
      account_id: "",
      block_number: 0,
      nonce: 0,
      consumers: 0,
      providers: 0,
      sufficients: 0,
      free_balance: "0",
      reserved_balance: "0",
      misc_frozen_balance: "0",
      fee_frozen_balance: "0",
      total_balance: cumulativeBalance.toString(),
      processed_timestamp: dailyCredits[dateStr]?.timestamp || credits[0].date,
    });
  }

  return result;
}

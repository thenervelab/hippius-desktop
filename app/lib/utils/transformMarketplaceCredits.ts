import { MarketplaceCreditObject } from "@/lib/hooks/api/useMarketplaceCredits";
import { Account } from "@/lib/types";

/**
 * Transforms marketplace credits data by aggregating credits for the same date
 * and converting to the Account format expected by the chart component
 */
export function transformMarketplaceCreditsToAccounts(
  credits: MarketplaceCreditObject[]
): Account[] {
  if (!credits || credits.length === 0) return [];

  // Group credits by date (YYYY-MM-DD)
  const creditsByDate = credits.reduce(
    (acc, credit) => {
      // Extract just the date part (YYYY-MM-DD)
      const dateKey = new Date(credit.date).toISOString().split("T")[0];

      if (!acc[dateKey]) {
        acc[dateKey] = {
          totalAmount: "0",
          date: credit.date,
        };
      }

      // Add current credit amount to the accumulated total
      const currentAmount = BigInt(credit.amount);
      const existingAmount = BigInt(acc[dateKey].totalAmount);
      acc[dateKey].totalAmount = (existingAmount + currentAmount).toString();

      return acc;
    },
    {} as Record<string, { totalAmount: string; date: string }>
  );

  // Convert to Account format and sort by date
  const result = Object.values(creditsByDate).map(({ totalAmount, date }) => ({
    account_id: "", // Not needed for chart display
    block_number: 0, // Not needed for chart display
    nonce: 0,
    consumers: 0,
    providers: 0,
    sufficients: 0,
    free_balance: "0",
    reserved_balance: "0",
    misc_frozen_balance: "0",
    fee_frozen_balance: "0",
    total_balance: totalAmount,
    processed_timestamp: date,
  }));

  // Sort by date (oldest to newest)
  return result.sort(
    (a, b) =>
      new Date(a.processed_timestamp).getTime() -
      new Date(b.processed_timestamp).getTime()
  );
}

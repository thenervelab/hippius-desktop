import { FileObject } from "@/lib/hooks/api/useFilesSize";
import { Account } from "@/lib/types";

/**
 * Transforms files data by aggregating file sizes for the same date
 * and converting to the Account format expected by the chart component
 */
export function transformFilesToStorageData(files: FileObject[]): Account[] {
  if (!files || files.length === 0) return [];

  // Group files by date (YYYY-MM-DD)
  const filesByDate = files.reduce(
    (acc, file) => {
      // Extract just the date part (YYYY-MM-DD)
      const dateKey = new Date(file.date).toISOString().split("T")[0];

      if (!acc[dateKey]) {
        acc[dateKey] = {
          totalSize: "0",
          date: file.date,
        };
      }

      // Add current file size to the accumulated total
      const currentSize = BigInt(file.totalSize);
      const existingSize = BigInt(acc[dateKey].totalSize);
      acc[dateKey].totalSize = (existingSize + currentSize).toString();

      return acc;
    },
    {} as Record<string, { totalSize: string; date: string }>
  );

  // Convert to Account format and sort by date
  const result = Object.values(filesByDate).map(({ totalSize, date }) => ({
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
    total_balance: totalSize, // Using total_balance field to store file size
    processed_timestamp: date,
  }));

  // Sort by date (oldest to newest)
  return result.sort(
    (a, b) =>
      new Date(a.processed_timestamp).getTime() -
      new Date(b.processed_timestamp).getTime()
  );
}

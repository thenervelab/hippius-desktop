export interface ChartPoint {
  x: string; // ISO date string, convert to Date when needed
  balance: number;
  formattedBalance: string;
  timestamp: string;
  dayLabel: string;
  bandLabel?: string;
  credit?: number;
  formattedCredit?: string;
}

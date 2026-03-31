import {
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";
import { normalizeIsoToMillis } from "@/lib/utils/dateUtils";

/** Row as returned by the new API */
export interface BalanceRow {
  id: number;
  block_number: number;
  account_id: string;
  free_balance: string;
  timestamp: number; // ms since epoch
  processed_timestamp: string; // ISO
}

/** Generic paged shape: { data, pagination } */
export interface PagedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}
export interface BalanceObject {
  accountId: string;
  blockNumber: number;
  freeBalance: string;
  reservedBalance: string;
  totalBalance: string;
  frozenBalance: string;
  timestamp: string;
}

export interface UseBalanceParams {
  page?: number;
  limit?: number; // default to 20000
}

/** API sometimes sends seconds; make sure we are in ms */
const unitSafeMs = (t: number): number => (t < 1e12 ? t * 1000 : t);

/** Use processed time when present; fallback to numeric timestamp */
const rowMs = (r: BalanceRow): number => {
  const p = normalizeIsoToMillis(r.processed_timestamp);
  if (p !== null) return p;
  return unitSafeMs(r.timestamp);
};

/** Build a LOCAL day key (user's machine local time) */
const localDayKey = (ms: number): string => {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** Keep only the latest entry per LOCAL day, based on processed time */
function latestPerLocalDay(rows: BalanceRow[]): BalanceRow[] {
  const map = new Map<string, BalanceRow>();
  for (const r of rows) {
    const t = rowMs(r);
    const key = localDayKey(t);
    const prev = map.get(key);
    if (!prev || t > rowMs(prev)) map.set(key, r);
  }
  // Sort by recency using the same clock
  return Array.from(map.values()).sort((a, b) => rowMs(b) - rowMs(a));
}

function toBalanceObject(row: BalanceRow): BalanceObject {
  const t = rowMs(row); // local pick logic above; we output UTC below
  return {
    accountId: row.account_id,
    blockNumber: row.block_number,
    freeBalance: row.free_balance,
    reservedBalance: "0",
    totalBalance: row.free_balance,
    frozenBalance: "0",
    // Return a clean UTC ISO for consistent downstream parsing
    timestamp: new Date(t).toISOString(),
  };
}

export default function useSystemBalance(
  params?: UseBalanceParams,
  options?: Omit<
    UseQueryOptions<PagedResponse<BalanceRow>, Error, BalanceObject[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<BalanceObject[], Error> {
  const page = params?.page ?? 1;
  const limit = params?.limit ?? 20000;

  return useInvokeQuery<PagedResponse<BalanceRow>, BalanceObject[]>({
    command: "get_system_balance_history",
    queryKey: (addr) => ["balance-daily", addr, page, limit],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      page,
      limit,
    }),
    options: {
      select: (resp) => {
        if (!resp?.data?.length) return [];
        const filtered = latestPerLocalDay(resp.data);
        return filtered.map(toBalanceObject);
      },
      placeholderData: keepPreviousData,
      ...options,
    },
  });
}

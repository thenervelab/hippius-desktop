import {
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";
import { normalizeIsoToMillis } from "@/lib/utils/dateUtils";

// Define types based on the indexer API response
export interface CreditEvent {
  id: string;
  block_number: number;
  account_id: string;
  credits: string;
  timestamp: number;
  processed_timestamp: string;
}

export interface CreditsResponse {
  data: CreditEvent[];
}

// Modified structure for UI consumption
export interface CreditObject {
  id: string;
  block: number;
  amount: string;
  accountId: string;
  date: string;
}

export interface UseCreditsParams {
  page?: number;
  limit?: number;
}

/** API sometimes sends seconds; make sure we are in ms */
const unitSafeMs = (t: number): number => (t < 1e12 ? t * 1000 : t);

/** Use processed time when present; fallback to numeric timestamp */
const rowMs = (r: CreditEvent): number => {
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
function latestPerLocalDay(rows: CreditEvent[]): CreditEvent[] {
  const map = new Map<string, CreditEvent>();
  for (const r of rows) {
    const t = rowMs(r);
    const key = localDayKey(t);
    const prev = map.get(key);
    if (!prev || t > rowMs(prev)) map.set(key, r);
  }
  // Sort by recency using the same clock
  return Array.from(map.values()).sort((a, b) => rowMs(b) - rowMs(a));
}

function toCreditObject(credit: CreditEvent): CreditObject {
  const t = rowMs(credit);
  return {
    id: credit.id,
    block: credit.block_number,
    amount: credit.credits,
    accountId: credit.account_id,
    date: new Date(t).toISOString(),
  };
}

export default function useCredits(
  params?: UseCreditsParams,
  options?: Omit<
    UseQueryOptions<CreditsResponse, Error, CreditObject[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<CreditObject[], Error> {
  const page = params?.page || 1;
  const limit = params?.limit || 100000;

  return useInvokeQuery<CreditsResponse, CreditObject[]>({
    command: "get_indexer_credits",
    queryKey: (addr) => ["credits", addr, page, limit],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      page,
      limit,
    }),
    options: {
      select: (data) => {
        if (!data?.data?.length) return [];
        const filtered = latestPerLocalDay(data.data);
        return filtered.map(toCreditObject);
      },
      placeholderData: keepPreviousData,
      ...options,
    },
  });
}

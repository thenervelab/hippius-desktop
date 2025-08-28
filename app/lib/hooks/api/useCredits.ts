import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "@/lib/constants";

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

const normalizeIsoToMillis = (iso?: string): number | null => {
  if (!iso) return null;
  const s = iso.trim();

  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return direct;

  // Normalize fraction to 3 digits (ms)
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d+))?Z$/);
  if (!m) return null;
  const base = m[1];
  const frac = (m[3] ?? "").padEnd(3, "0").slice(0, 3);
  const safeIso = frac ? `${base}.${frac}Z` : `${base}.000Z`;
  const t = Date.parse(safeIso);
  return Number.isNaN(t) ? null : t;
};

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
  const { polkadotAddress } = useWalletAuth();
  const page = params?.page || 1;
  const limit = params?.limit || 100000;

  return useQuery<CreditsResponse, Error, CreditObject[]>({
    queryKey: ["credits", polkadotAddress, page, limit],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const url = `${API_BASE_URL}/credits/free-credits?account_id=${polkadotAddress}&limit=${limit}&page=${page}`;

      const response = await fetch(url, {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch credits: ${response.status}`);
      }

      return (await response.json()) as CreditsResponse;
    },
    select: (data) => {
      if (!data?.data?.length) return [];
      const filtered = latestPerLocalDay(data.data);
      return filtered.map(toCreditObject);
    },
    placeholderData: keepPreviousData,
    enabled: !!polkadotAddress,
    ...options,
  });
}

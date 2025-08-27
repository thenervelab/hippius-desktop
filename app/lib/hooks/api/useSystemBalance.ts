import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "@/lib/constants";

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
const rowMs = (r: BalanceRow): number => {
  const p = normalizeIsoToMillis(r.processed_timestamp);
  if (p !== null) return p;
  return unitSafeMs(r.timestamp);
};

/** Build a LOCAL day key (user’s machine local time) */
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
  const { polkadotAddress } = useWalletAuth();

  const page = params?.page ?? 1;
  const limit = params?.limit ?? 20000;

  return useQuery<PagedResponse<BalanceRow>, Error, BalanceObject[]>({
    queryKey: ["balance-daily", polkadotAddress, page, limit],
    queryFn: async () => {
      if (!polkadotAddress) throw new Error("No wallet address available");

      const url =
        `${API_BASE_URL}` +
        `/system-account-balance?account_id=${encodeURIComponent(
          polkadotAddress
        )}` +
        `&page=${page}&limit=${limit}`;

      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`Failed to fetch balance: ${res.status}`);

      return (await res.json()) as PagedResponse<BalanceRow>;
    },
    select: (resp) => {
      if (!resp?.data?.length) return [];
      const filtered = latestPerLocalDay(resp.data);
      return filtered.map(toBalanceObject);
    },

    placeholderData: keepPreviousData,
    enabled: !!polkadotAddress,
    ...options,
  });
}

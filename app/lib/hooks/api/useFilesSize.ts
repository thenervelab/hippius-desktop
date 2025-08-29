import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "@/lib/constants";

// Define types based on the indexer API response
export interface FileEvent {
  id: string;
  block_number: number;
  account_id: string;
  total_files_size: string;
  timestamp: number;
  processed_timestamp: string;
}

export interface FilesResponse {
  data: FileEvent[];
}

// Modified structure for UI consumption
export interface FileObject {
  id: string;
  block: number;
  totalSize: string;
  accountId: string;
  date: string;
  timestamp: number;
}

// Chart data format
export interface FileChartData {
  account_id: string;
  block_number: number;
  nonce: number;
  consumers: number;
  providers: number;
  sufficients: number;
  free_balance: string;
  reserved_balance: string;
  misc_frozen_balance: string;
  fee_frozen_balance: string;
  total_balance: string;
  processed_timestamp: string;
}

export interface UseFilesParams {
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
const rowMs = (r: FileEvent): number => {
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
function latestPerLocalDay(rows: FileEvent[]): FileEvent[] {
  const map = new Map<string, FileEvent>();
  for (const r of rows) {
    const t = rowMs(r);
    const key = localDayKey(t);
    const prev = map.get(key);
    if (!prev || t > rowMs(prev)) map.set(key, r);
  }
  // Sort by recency using the same clock
  return Array.from(map.values()).sort((a, b) => rowMs(b) - rowMs(a));
}

function toChartFormat(file: FileEvent): FileChartData {
  const t = rowMs(file);
  return {
    account_id: file.account_id,
    block_number: file.block_number,
    nonce: 0,
    consumers: 0,
    providers: 0,
    sufficients: 0,
    free_balance: "0",
    reserved_balance: "0",
    misc_frozen_balance: "0",
    fee_frozen_balance: "0",
    total_balance: file.total_files_size, // Using total_balance field to store file size
    processed_timestamp: new Date(t).toISOString(),
  };
}

export default function useFiles(
  params?: UseFilesParams,
  options?: Omit<
    UseQueryOptions<FilesResponse, Error, FileChartData[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<FileChartData[], Error> {
  const { polkadotAddress } = useWalletAuth();
  const page = params?.page || 1;
  const limit = params?.limit || 100000;

  return useQuery<FilesResponse, Error, FileChartData[]>({
    queryKey: ["files", polkadotAddress, page, limit],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const url = `${API_BASE_URL}/ipfs/user-total-files-size?limit=${limit}&account_id=${polkadotAddress}`;

      const response = await fetch(url, {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch files: ${response.status}`);
      }

      return (await response.json()) as FilesResponse;
    },
    select: (data) => {
      if (!data?.data?.length) return [];
      const filtered = latestPerLocalDay(data.data);
      return filtered.map(toChartFormat);
    },
    placeholderData: keepPreviousData,
    enabled: !!polkadotAddress,
    ...options,
  });
}

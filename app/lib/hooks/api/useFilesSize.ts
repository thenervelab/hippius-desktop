import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "@/lib/constants";
import { sciToFullString } from "../../utils/formatters/formatBalance";

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
function toChartFormat(file: FileEvent): FileChartData {
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
    processed_timestamp: new Date(file.processed_timestamp).toISOString(),
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
      const filtered = data.data.map((storage) => ({
        ...storage,
        total_files_size: storage.total_files_size.includes("+")
          ? sciToFullString(storage.total_files_size)
          : storage.total_files_size,
      }));
      return filtered.map(toChartFormat);
    },
    placeholderData: keepPreviousData,
    enabled: !!polkadotAddress,
    ...options,
  });
}

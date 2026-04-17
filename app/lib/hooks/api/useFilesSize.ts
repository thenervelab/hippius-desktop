import {
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";
import { sciToFullString } from "../../utils/formatters/sciToFullString";

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
  daysAgo?: number;
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
  const daysAgo = params?.daysAgo || 30;

  return useInvokeQuery<FilesResponse, FileChartData[]>({
    command: "get_files_size",
    queryKey: (addr) => ["files", addr, daysAgo],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      daysAgo,
    }),
    options: {
      select: (data) => {
        if (!data?.data?.length) return [];
        // Convert scientific notation to full string and map to chart format
        const filtered = data.data.map((storage) => ({
          ...storage,
          total_files_size: storage.total_files_size.includes("+")
            ? sciToFullString(storage.total_files_size)
            : storage.total_files_size,
        }));
        // Return data directly from API without any delta calculations
        return filtered.map(toChartFormat);
      },
      placeholderData: keepPreviousData,
      ...options,
    },
  });
}

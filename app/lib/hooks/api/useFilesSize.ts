import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "../../constants";

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

export interface UseFilesParams {
  page?: number;
  limit?: number;
}

export default function useFiles(
  params?: UseFilesParams,
  options?: Omit<
    UseQueryOptions<FilesResponse, Error, FileObject[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<FileObject[], Error> {
  const { polkadotAddress } = useWalletAuth();
  const page = params?.page || 1;
  const limit = params?.limit || 10;

  return useQuery<FilesResponse, Error, FileObject[]>({
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
      return data.data.map((file) => ({
        id: file.id,
        block: file.block_number,
        totalSize: file.total_files_size,
        accountId: file.account_id,
        date: file.processed_timestamp,
        timestamp: file.timestamp,
      }));
    },
    placeholderData: keepPreviousData,
    enabled: !!polkadotAddress,
    ...options,
  });
}

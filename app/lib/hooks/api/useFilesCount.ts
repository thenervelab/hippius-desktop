import { useInvokeQuery } from "./useInvokeQuery";

interface FilesCountEvent {
  id: number;
  block_number: number;
  account_id: string;
  total_files_count: string;
  timestamp: number;
  processed_timestamp: string;
}

interface FilesCountResponse {
  data: FilesCountEvent[];
}

export default function useFilesCount() {
  return useInvokeQuery<FilesCountResponse, number>({
    command: "get_files_count",
    queryKey: (addr) => ["files-count", addr],
    options: {
      staleTime: 60_000,
      select: (data) => {
        if (!data?.data?.length) return 0;
        // Latest entry = current file count
        const latest = data.data[0];
        return parseInt(latest.total_files_count, 10) || 0;
      },
    },
  });
}

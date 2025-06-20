import { Pagination } from "./pagination";
import { FileNodeMetric } from "./nodes";

export interface FileRecord {
  id: number;
  cid: string;
  owner: string;
  [key: `miner${number}`]: string;
  created_at: number;
  updated_at: number;
  processed_timestamp: string;
  profile_cid: string;
  file_name: string;
  metrics?: FileNodeMetric[];
  notHostedMetrices?: FileNodeMetric[] | MinerIdHost[];
}

export interface FilesResponse {
  files: FileRecord[];
  pagination: Pagination | undefined;
}
export interface MinerIdHost {
  miner_id: string;
}

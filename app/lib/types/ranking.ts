import { Pagination } from "./pagination";

export interface Ranking {
  is_active: boolean;
  last_updated_block: number;
  node_id: string;
  node_ss58_address: string;
  node_type: string;
  rank: number;
  weight: number;
}

export interface RankingResponse {
  block_number: number;
  pagination: Pagination;
  ranking: Ranking[];
}

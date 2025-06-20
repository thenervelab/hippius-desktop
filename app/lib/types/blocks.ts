import { Pagination } from "./pagination";

/**
 * Single block record returned by the Blocks API.
 */
export interface Block {
  author: string;
  block_hash: string;
  block_number: number;
  extrinsics_root: string;
  parent_hash: string;
  spec_version: number;
  state_root: string;
  timestamp: number;
  events_count: number;
  extrinsics_count: number;
}

/**
 * Full response from the Blocks endpoint.
 */
export interface BlocksResponse {
  blocks: Block[];
  pagination: Pagination;
}

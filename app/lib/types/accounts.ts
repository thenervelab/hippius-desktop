import { Pagination } from "./pagination";

/** One account record */
export interface Account {
  account_id?: string;
  block_number?: number;
  nonce?: number;
  consumers?: number;
  providers?: number;
  sufficients?: number;
  free_balance?: string;
  reserved_balance?: string;
  misc_frozen_balance?: string;
  fee_frozen_balance?: string;
  total_balance: string;
  credit?: string;
  processed_timestamp: string;
}

/** Full response from `/accounts` endpoint */
export interface AccountsResponse {
  accounts: Account[];
  pagination: Pagination;
}

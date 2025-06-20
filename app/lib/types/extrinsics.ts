import { Pagination } from "./pagination";

export interface ErrorInfo {
  docs: string;
  errorName: string;
  pallet: string;
}

export interface Extrinsic {
  block_number: number;
  extrinsic_index: number;
  extrinsic_hash: string;
  is_signed: boolean;
  signer: string | null;
  method_pallet: string;
  method_name: string;
  args: string[];
  nonce: number | null;
  era: string;
  tip: string;
  pays_fee: boolean;
  success: boolean;
  weight: Record<string, unknown>;
  class: string;
  error_info: ErrorInfo | null;
  processed_timestamp: string;
}

export interface ExtrinsicsResponse {
  extrinsics: Extrinsic[];
  pagination: Pagination;
}

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "@/lib/constants";

// Define types based on the indexer API response
export interface AccountData {
  account_id: string;
  block_number: number;
  nonce: string;
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

export interface AccountResponse {
  accounts: AccountData[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

// Modified structure for UI consumption
export interface BalanceObject {
  accountId: string;
  blockNumber: number;
  freeBalance: string;
  reservedBalance: string;
  totalBalance: string;
  frozenBalance: string;
  timestamp: string;
}

export interface UseBalanceParams {
  page?: number;
  limit?: number;
}

export default function useBalance(
  params?: UseBalanceParams,
  options?: Omit<
    UseQueryOptions<AccountResponse, Error, BalanceObject | null>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<BalanceObject | null, Error> {
  const { polkadotAddress } = useWalletAuth();
  const page = params?.page || 1;
  const limit = params?.limit || 10;

  return useQuery<AccountResponse, Error, BalanceObject | null>({
    queryKey: ["balance", polkadotAddress, page, limit],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const url = `${API_BASE_URL}/account?account_id=${polkadotAddress}`;

      const response = await fetch(url, {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch balance: ${response.status}`);
      }

      return (await response.json()) as AccountResponse;
    },
    select: (data) => {
      if (!data.accounts || data.accounts.length === 0) {
        return null;
      }

      const account = data.accounts[0];
      return {
        accountId: account.account_id,
        blockNumber: account.block_number,
        freeBalance: account.free_balance,
        reservedBalance: account.reserved_balance,
        totalBalance: account.total_balance,
        frozenBalance: account.misc_frozen_balance,
        timestamp: account.processed_timestamp,
      };
    },
    placeholderData: keepPreviousData,
    enabled: !!polkadotAddress,
    ...options,
  });
}

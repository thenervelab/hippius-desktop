import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "@/lib/constants";

// Define types based on the indexer API response
export interface CreditEvent {
  id: string;
  block_number: number;
  account_id: string;
  credits: string;
  timestamp: number;
  processed_timestamp: string;
}

export interface CreditsResponse {
  data: CreditEvent[];
}

// Modified structure for UI consumption
export interface CreditObject {
  id: string;
  block: number;
  amount: string;
  accountId: string;
  date: string;
}

export interface UseCreditsParams {
  page?: number;
  limit?: number;
}

export default function useCredits(
  params?: UseCreditsParams,
  options?: Omit<
    UseQueryOptions<CreditsResponse, Error, CreditObject[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<CreditObject[], Error> {
  const { polkadotAddress } = useWalletAuth();
  const page = params?.page || 1;
  const limit = params?.limit || 10;

  return useQuery<CreditsResponse, Error, CreditObject[]>({
    queryKey: ["credits", polkadotAddress, page, limit],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const url = `${API_BASE_URL}/credits/free-credits?account_id=${polkadotAddress}`;

      const response = await fetch(url, {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch credits: ${response.status}`);
      }

      return (await response.json()) as CreditsResponse;
    },
    select: (data) => {
      return data.data.map((credit) => ({
        id: credit.id,
        block: credit.block_number,
        amount: credit.credits,
        accountId: credit.account_id,
        date: credit.processed_timestamp,
      }));
    },
    placeholderData: keepPreviousData,
    enabled: !!polkadotAddress,
    ...options,
  });
}

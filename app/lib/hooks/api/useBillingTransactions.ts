import { useState, useEffect } from "react";
// import { authService } from "@/lib/services/auth-service";

export interface BillingTransaction {
  id: string;
  payment_type: string;
  amount: number | string;
  currency: string;
  description?: string;
  credits?: number;
  status: string;
  ready_for_mint?: boolean;
  minted?: boolean;
  created_at: string;
  completed_at?: string;
}

interface BillingTransactionsResponse {
  results: BillingTransaction[];
  count: number;
  next: string | null;
  previous: string | null;
}

export interface TransactionObject {
  id: string;
  type: "card" | "tao";
  amount: number;
  date: string;
  description: string;
}

// Dummy data for development
const dummyApiResponse: BillingTransactionsResponse = {
  count: 4,
  next: null,
  previous: null,
  results: [
    {
      id: "71ef5e56-b646-4355-9666-ad33c08790b7",
      payment_type: "stripe",
      amount: "20.00000000",
      currency: "USD",
      credits: 20,
      status: "payment_confirmed",
      ready_for_mint: true,
      minted: false,
      created_at: "2025-06-25T07:20:49.861262Z",
      completed_at: "2025-06-25T07:21:23.175707Z",
    },
    {
      id: "4766e172-3595-42c7-b7ec-df1a05e64ef7",
      payment_type: "stripe",
      amount: "10.00000000",
      currency: "USD",
      credits: 10,
      status: "payment_confirmed",
      ready_for_mint: true,
      minted: false,
      created_at: "2025-06-25T17:52:27.291579Z",
      completed_at: "2025-06-25T17:56:29.741605Z",
    },
    {
      id: "1f42460f-5448-4415-a0d4-9b0fe91d6294",
      payment_type: "stripe",
      amount: "20.00000000",
      currency: "USD",
      credits: 20,
      status: "failed",
      ready_for_mint: false,
      minted: false,
      created_at: "2025-06-25T18:20:07.142733Z",
      completed_at: "2025-06-26T18:20:08.335394Z",
    },
    {
      id: "22c7cbb3-2319-4e92-a589-7e0d1b37ecd2",
      payment_type: "stripe",
      amount: "20.00000000",
      currency: "USD",
      credits: 20,
      status: "payment_confirmed",
      ready_for_mint: true,
      minted: false,
      created_at: "2025-06-25T18:20:52.449000Z",
      completed_at: "2025-06-25T18:21:37.443140Z",
    },
  ],
};

export default function useBillingTransactions() {
  const [transactions, setTransactions] = useState<TransactionObject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [previousPage, setPreviousPage] = useState<string | null>(null);

  const fetchTransactions = async (url?: string) => {
    console.log("url", url);
    try {
      setIsLoading(true);
      // Commented out for now, will use later
      // const authToken = authService.getAuthToken();
      // if (!authToken) {
      //   throw new Error("Not authenticated");
      // }

      // Instead of making an API call, use the dummy data
      // const fetchUrl = url || "https://api.hippius.com/api/billing/transactions/";
      // const response = await fetch(fetchUrl, {
      //   headers: {
      //     Authorization: `Token ${authToken}`,
      //     Accept: "application/json",
      //   },
      // });

      // if (!response.ok) {
      //   throw new Error(`Failed to fetch billing transactions: ${response.status}`);
      // }

      // const data: BillingTransactionsResponse = await response.json();

      // Using dummy data instead
      const data = dummyApiResponse;

      // Update pagination data
      setTotalCount(data.count);
      setNextPage(data.next);
      setPreviousPage(data.previous);

      // Transform API data to match expected TransactionObject structure
      const transformedData = data.results.map((transaction) => ({
        id: transaction.id,
        type: transaction.payment_type.toLowerCase().includes("stripe")
          ? "card"
          : "tao",
        amount:
          typeof transaction.amount === "string"
            ? parseFloat(transaction.amount)
            : transaction.amount,
        date: transaction.created_at,
        description:
          transaction.description || `Payment - ${transaction.payment_type}`,
      })) as TransactionObject[];

      setTransactions(transformedData);
      setError(null);
    } catch (error) {
      console.error("Error fetching billing transactions:", error);
      setError(error instanceof Error ? error.message : "Unknown error");
      setTransactions([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch transactions on component mount
  useEffect(() => {
    fetchTransactions();
  }, []);

  // Function to load next page of results
  const fetchNextPage = () => {
    if (nextPage) {
      fetchTransactions(nextPage);
    }
  };

  // Function to load previous page of results
  const fetchPreviousPage = () => {
    if (previousPage) {
      fetchTransactions(previousPage);
    }
  };

  return {
    data: transactions,
    isPending: isLoading,
    error,
    totalCount,
    hasNextPage: !!nextPage,
    hasPreviousPage: !!previousPage,
    fetchNextPage,
    fetchPreviousPage,
    refetch: fetchTransactions,
  };
}

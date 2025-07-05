import { useState, useEffect } from "react";
import { authService } from "@/lib/services/auth-service";

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
      const authToken = authService.getAuthToken();
      if (!authToken) {
        throw new Error("Not authenticated");
      }
      const fetchUrl =
        url || "https://api.hippius.com/api/billing/transactions/";
      const response = await fetch(fetchUrl, {
        headers: {
          Authorization: `Token ${authToken}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch billing transactions: ${response.status}`
        );
      }

      const data: BillingTransactionsResponse = await response.json();

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

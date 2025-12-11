import { useQuery } from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";

export interface ApiBucket {
    name: string;
    creation_date?: string;
}

export function useApiBuckets(token: string | null) {
    const {
        data: buckets = [],
        isLoading,
        isError,
        refetch,
    } = useQuery<ApiBucket[]>({
        queryKey: ["api-buckets", token],
        queryFn: async () => {
            if (!token) {
                return [];
            }

            const response = await fetch(
                `${API_CONFIG.baseUrl}/api/objectstore/buckets/`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `Token ${token}`,
                        Accept: "application/json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch buckets: ${response.status}`);
            }

            const data = await response.json();
            return data.results || data || [];
        },
        enabled: !!token,
        refetchOnWindowFocus: false,
    });

    return {
        buckets,
        isLoading,
        isError,
        refetch,
    };
}

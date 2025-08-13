import { useQueries, useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/lib/constants";

export interface NodeMetric {
    miner_id: string;
    network_city: string;
    network_country: string;
    network_location: string;
    geolocation: string;
}

export interface NodeMetricsResponse {
    metrics: NodeMetric[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        total_pages: number;
    };
}

export interface NodeLocation {
    location: string;
    minerId: string;
}

export function useNodeLocations(minerIds: string[] = []) {
    const queries = useQueries({
        queries: minerIds.map(minerId => ({
            queryKey: ['node-metrics', minerId],
            queryFn: async () => {
                if (!minerId) return null;

                const url = `${API_BASE_URL}/node-metrics?page=1&limit=1&miner_id=${minerId}`;

                const response = await fetch(url, {
                    headers: {
                        accept: "application/json",
                    },
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch node metrics: ${response.status}`);
                }

                const data = await response.json() as NodeMetricsResponse;

                if (!data.metrics || data.metrics.length === 0) {
                    return null;
                }

                const metric = data.metrics[0];
                const city = metric.network_city && metric.network_city !== "null," ? metric.network_city : null;
                const country = metric.network_country && metric.network_country !== "null," ? metric.network_country : null;

                let locationStr = "";
                if (city && country) {
                    locationStr = `${city}, ${country}`;
                } else if (city) {
                    locationStr = city;
                } else if (country) {
                    locationStr = country;
                } else {
                    return null;
                }

                return {
                    minerId,
                    location: locationStr,
                } as NodeLocation;
            },
            enabled: !!minerId,
        })),
    });

    const isLoading = queries.some(query => query.isLoading);
    const error = queries.find(query => query.error)?.error || null;

    const nodeLocations = queries
        .map(query => query.data)
        .filter((data): data is NodeLocation => !!data);

    const uniqueLocations = [...new Set(nodeLocations.map(loc => loc.location))];

    return {
        nodeLocations,
        uniqueLocations,
        isLoading,
        error
    };
}

export function useSingleNodeLocation(minerId: string | undefined) {
    return useQuery<NodeLocation | null>({
        queryKey: ['node-metrics', minerId],
        queryFn: async () => {
            if (!minerId) return null;

            const url = `${API_BASE_URL}/node-metrics?page=1&limit=1&miner_id=${minerId}`;

            const response = await fetch(url, {
                headers: {
                    accept: "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch node metrics: ${response.status}`);
            }

            const data = await response.json() as NodeMetricsResponse;

            if (!data.metrics || data.metrics.length === 0) {
                return null;
            }

            const metric = data.metrics[0];
            const city = metric.network_city && metric.network_city !== "null" ? metric.network_city : null;
            const country = metric.network_country && metric.network_country !== "null" ? metric.network_country : null;

            let locationStr = "";
            if (city && country) {
                locationStr = `${city} ${country}`;
            } else if (city) {
                locationStr = city;
            } else if (country) {
                locationStr = country;
            } else {
                return null;
            }

            return {
                minerId,
                location: locationStr,
            };
        },
        enabled: !!minerId,
    });
}

import { useSearchParams } from "next/navigation";

/**
 * Custom hook for handling URL search parameters
 * @returns Object with methods to retrieve URL parameters
 */
export function useUrlParams() {
    const searchParams = useSearchParams();

    /**
     * Get a parameter value with optional default
     * @param key The parameter key to retrieve
     * @param defaultValue Optional default value if parameter is not present
     * @returns The parameter value or the default value
     */
    const getParam = <T extends string>(key: string, defaultValue?: T): string | T => {
        const value = searchParams.get(key);
        return value !== null ? value : defaultValue ?? "";
    };

    /**
     * Get multiple parameters at once with optional default values
     * @param config Object with keys as parameter names and values as default values
     * @returns Object with the same keys and resolved values
     */
    const getParams = <T extends Record<string, string | undefined>>(
        config: T
    ): Record<keyof T, string | null> => {
        const result: Record<string, string | null> = {};

        for (const [key, defaultValue] of Object.entries(config)) {
            result[key] = getParam(key, defaultValue);
        }

        return result as Record<keyof T, string | null>;
    };

    return {
        getParam,
        getParams,
        getAllParams: () => Object.fromEntries(searchParams.entries()),
        has: (key: string) => searchParams.has(key),
        searchParams,
    };
}

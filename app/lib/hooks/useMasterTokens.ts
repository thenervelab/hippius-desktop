import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { API_CONFIG } from "@/lib/config";
import {
    MasterToken,
    MasterTokenCreateInput,
    MasterTokenCreateResponse,
    MasterTokenRotateResponse,
    MasterTokenRevokeResponse,
} from "@/app/lib/types/masterToken";

export const MASTER_TOKENS_QUERY_KEY = "master-tokens";

// Fetch all master tokens
async function fetchMasterTokens(oauthToken: string): Promise<MasterToken[]> {
    const response = await fetch(
        `${API_CONFIG.baseUrl}/api/objectstore/master-tokens/`,
        {
            method: "GET",
            headers: {
                Authorization: `Token ${oauthToken}`,
                Accept: "application/json",
            },
        }
    );

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData.detail || errorData.error || `Failed to fetch master tokens: ${response.status}`
        );
    }

    return await response.json();
}

// Create a new master token
async function createMasterToken(
    oauthToken: string,
    input: MasterTokenCreateInput
): Promise<MasterTokenCreateResponse> {
    const response = await fetch(
        `${API_CONFIG.baseUrl}/api/objectstore/master-tokens/`,
        {
            method: "POST",
            headers: {
                Authorization: `Token ${oauthToken}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                name: input.name,
                expires_at: input.expires_at,
            }),
        }
    );

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData.detail || errorData.error || `Failed to create master token: ${response.status}`
        );
    }

    const result = await response.json();
    console.log("Master token creation API response:", result);
    return result;
}

// Revoke a master token
async function revokeMasterToken(
    oauthToken: string,
    tokenId: string
): Promise<MasterTokenRevokeResponse> {
    const response = await fetch(
        `${API_CONFIG.baseUrl}/api/objectstore/master-tokens/${tokenId}/revoke/`,
        {
            method: "POST",
            headers: {
                Authorization: `Token ${oauthToken}`,
                Accept: "application/json",
            },
        }
    );

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData.detail || errorData.error || `Failed to revoke master token: ${response.status}`
        );
    }

    return await response.json();
}

// Rotate a master token
async function rotateMasterToken(
    oauthToken: string,
    tokenId: string
): Promise<MasterTokenRotateResponse> {
    const response = await fetch(
        `${API_CONFIG.baseUrl}/api/objectstore/master-tokens/${tokenId}/rotate/`,
        {
            method: "POST",
            headers: {
                Authorization: `Token ${oauthToken}`,
                Accept: "application/json",
            },
        }
    );

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
            errorData.detail || errorData.error || `Failed to rotate master token: ${response.status}`
        );
    }

    return await response.json();
}

export function useMasterTokens() {
    const { oauthSession } = useWalletAuth();
    const queryClient = useQueryClient();

    const queryKey = [MASTER_TOKENS_QUERY_KEY, oauthSession?.userId];

    // Query to fetch all master tokens
    const {
        data: tokens = [],
        isLoading,
        isRefetching,
        error,
        refetch,
    } = useQuery({
        queryKey,
        queryFn: async () => {
            if (!oauthSession?.token) {
                throw new Error("No authentication token available");
            }
            return await fetchMasterTokens(oauthSession.token);
        },
        enabled: !!oauthSession?.token,
        staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
        gcTime: 1800000,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        retry: 1,
    });

    // Check if user has at least one active, non-expired master token
    const hasActiveMasterToken = tokens.some((token) => {
        if (token.status !== "active") return false;
        const expiresAt = new Date(token.expires_at);
        return expiresAt > new Date();
    });

    // Create mutation
    const createMutation = useMutation({
        mutationFn: async (input: MasterTokenCreateInput) => {
            if (!oauthSession?.token) {
                throw new Error("No authentication token available");
            }
            return await createMasterToken(oauthSession.token, input);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey });
            toast.success("Master token created successfully");
        },
        onError: (error: Error) => {
            toast.error(error.message || "Failed to create master token");
        },
    });

    // Revoke mutation
    const revokeMutation = useMutation({
        mutationFn: async (tokenId: string) => {
            if (!oauthSession?.token) {
                throw new Error("No authentication token available");
            }
            return await revokeMasterToken(oauthSession.token, tokenId);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey });
            toast.success("Master token revoked successfully");
        },
        onError: (error: Error) => {
            toast.error(error.message || "Failed to revoke master token");
        },
    });

    // Rotate mutation
    const rotateMutation = useMutation({
        mutationFn: async (tokenId: string) => {
            if (!oauthSession?.token) {
                throw new Error("No authentication token available");
            }
            return await rotateMasterToken(oauthSession.token, tokenId);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey });
            toast.success("Master token rotated successfully");
        },
        onError: (error: Error) => {
            toast.error(error.message || "Failed to rotate master token");
        },
    });

    const create = useCallback(
        async (input: MasterTokenCreateInput) => {
            return await createMutation.mutateAsync(input);
        },
        [createMutation]
    );

    const revoke = useCallback(
        async (tokenId: string) => {
            return await revokeMutation.mutateAsync(tokenId);
        },
        [revokeMutation]
    );

    const rotate = useCallback(
        async (tokenId: string) => {
            return await rotateMutation.mutateAsync(tokenId);
        },
        [rotateMutation]
    );

    return {
        tokens,
        hasActiveMasterToken,
        isLoading,
        isRefetching,
        error,
        refetch,
        create,
        revoke,
        rotate,
        isCreating: createMutation.isPending,
        isRevoking: revokeMutation.isPending,
        isRotating: rotateMutation.isPending,
    };
}

export default useMasterTokens;

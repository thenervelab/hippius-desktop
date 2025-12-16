import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiToken, CreateTokenInput, UpdateTokenInput, TokenStatus, SubTokenRotateResponse, SubTokenRevokeResponse } from "@/app/lib/types/apiToken";
import { toast } from "sonner";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { API_CONFIG } from "@/lib/config";

// Helper to transform API token to UI format
const transformToken = (token: ApiToken): ApiToken => {
    // Handle case where actions might be undefined (e.g., immediately after creation)
    const actions = token.actions;
    const actionsStr = actions
        ? (Array.isArray(actions) ? actions.join(',') : actions)
        : '';

    // Determine permission from actions (can be string or array)
    let permission: ApiToken['permission'];
    if (actionsStr.includes('write')) {
        permission = token.scope_type === 'all_buckets' ? 'Admin Read & Write' : 'Object Read & Write';
    } else {
        permission = token.scope_type === 'all_buckets' ? 'Admin Read Only' : 'Object Read Only';
    }

    // Determine appliedTo text
    const appliedTo = token.scope_type === 'all_buckets'
        ? 'All Buckets'
        : token.buckets && token.buckets.length > 0
            ? `${token.buckets.length} bucket${token.buckets.length > 1 ? 's' : ''}`
            : undefined; // Return undefined when no buckets so we can hide it

    return {
        ...token,
        permission,
        appliedTo,
        // Map API response fields to expected UI fields
        access_key_id: token.access_key_id || token.accessKeyId || '',
        secretAccessKey: token.secretAccessKey || token.secret,
        expires_at: token.expires_at || token.expiresAt || '',
        created_at: token.created_at || token.createdAt || '',
    };
};

export function useApiTokens() {
    const { oauthSession } = useWalletAuth();
    const queryClient = useQueryClient();

    // Fetch tokens
    const { data: tokens = [], isLoading, isRefetching, refetch } = useQuery({
        queryKey: ['api-tokens', oauthSession?.userId],
        enabled: !!oauthSession?.token,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
        queryFn: async () => {
            if (!oauthSession?.token) {
                throw new Error('No authentication token available');
            }

            const response = await fetch(`${API_CONFIG.baseUrl}/api/objectstore/sub-tokens/`, {
                method: 'GET',
                headers: {
                    Authorization: `Token ${oauthSession.token}`,
                    Accept: 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch tokens: ${response.status}`);
            }

            const data: ApiToken[] = await response.json();
            return data.map(transformToken);
        },
    });

    const createTokenMutation = useMutation({
        mutationFn: async (input: CreateTokenInput) => {
            if (!oauthSession?.token) {
                throw new Error('No authentication token available');
            }

            // Calculate expiration date
            let expires_at: string | undefined;

            const now = new Date();
            const not_before = now.toISOString();

            if (input.lifespan === "Custom" && input.customDate) {
                // Use custom date directly
                expires_at = input.customDate.toISOString();
            } else if (input.lifespan !== "Forever" && input.lifespan !== "Custom") {
                const lifespanDays: Record<string, number> = {
                    "7 days": 7,
                    "30 days": 30,
                    "1 year": 365,
                };
                const daysToAdd = lifespanDays[input.lifespan] || 0;
                const expiryDate = new Date(now);
                expiryDate.setDate(expiryDate.getDate() + daysToAdd);
                expires_at = expiryDate.toISOString();
            }

            // Determine actions based on permission
            const actions = input.permission.includes('Write') ? ['read', 'write'] : ['read'];

            const payload: Record<string, unknown> = {
                name: input.name,
                scope_type: input.applyToAll ? 'all_buckets' : 'single_bucket',
                actions,
                allowed_prefixes: [],
                ip_allowlist: [],
                not_before,
                expires_at: expires_at || not_before,
            };

            // Only add bucket_names if not applying to all buckets
            if (!input.applyToAll && input.buckets && input.buckets.length > 0) {
                payload.bucket_names = input.buckets;
            }

            const response = await fetch(`${API_CONFIG.baseUrl}/api/objectstore/sub-tokens/`, {
                method: 'POST',
                headers: {
                    Authorization: `Token ${oauthSession.token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || errorData.message || `Failed to create token: ${response.status}`);
            }

            const data: ApiToken = await response.json();
            return transformToken(data);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
            toast.success('Token created successfully');
        },
        onError: (error: Error) => {
            toast.error(`Failed to create token: ${error.message}`);
        },
    });

    const createToken = useCallback(async (input: CreateTokenInput): Promise<ApiToken> => {
        return createTokenMutation.mutateAsync(input);
    }, [createTokenMutation]);

    const updateTokenMutation = useMutation({
        mutationFn: async (input: UpdateTokenInput) => {
            if (!oauthSession?.token) {
                throw new Error('No authentication token available');
            }

            const payload: Record<string, unknown> = {};

            if (input.name) {
                payload.name = input.name;
            }

            if (input.permission) {
                payload.actions = input.permission.includes('Write') ? ['read', 'write'] : ['read'];
            }

            if (input.applyToAll !== undefined) {
                payload.scope_type = input.applyToAll ? 'all_buckets' : 'single_bucket';
                if (!input.applyToAll && input.buckets) {
                    payload.bucket_names = input.buckets;
                }
            }

            if (input.status) {
                payload.status = input.status;
            }

            const response = await fetch(`${API_CONFIG.baseUrl}/api/objectstore/sub-tokens/${input.id}/`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Token ${oauthSession.token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || errorData.message || `Failed to update token: ${response.status}`);
            }

            return response.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
            toast.success('Token updated successfully');
        },
        onError: (error: Error) => {
            toast.error(`Failed to update token: ${error.message}`);
        },
    });

    const updateToken = useCallback(async (input: UpdateTokenInput): Promise<void> => {
        await updateTokenMutation.mutateAsync(input);
    }, [updateTokenMutation]);

    const deleteTokenMutation = useMutation({
        mutationFn: async (id: string) => {
            if (!oauthSession?.token) {
                throw new Error('No authentication token available');
            }

            const response = await fetch(`${API_CONFIG.baseUrl}/api/objectstore/sub-tokens/${id}/`, {
                method: 'DELETE',
                headers: {
                    Authorization: `Token ${oauthSession.token}`,
                    Accept: 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to delete token: ${response.status}`);
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
            toast.success('Token deleted successfully');
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete token: ${error.message}`);
        },
    });

    const deleteToken = useCallback(async (id: string): Promise<void> => {
        await deleteTokenMutation.mutateAsync(id);
    }, [deleteTokenMutation]);

    const toggleTokenStatusMutation = useMutation({
        mutationFn: async (id: string) => {
            if (!oauthSession?.token) {
                throw new Error('No authentication token available');
            }

            const token = tokens.find(t => t.id === id);
            if (!token) {
                throw new Error('Token not found');
            }

            const newStatus: TokenStatus = token.status === 'active' ? 'disabled' : 'active';

            const response = await fetch(`${API_CONFIG.baseUrl}/api/objectstore/sub-tokens/${id}/`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Token ${oauthSession.token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({ status: newStatus }),
            });

            if (!response.ok) {
                throw new Error(`Failed to toggle token status: ${response.status}`);
            }

            return response.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
        },
        onError: (error: Error) => {
            toast.error(`Failed to toggle token status: ${error.message}`);
        },
    });

    const toggleTokenStatus = useCallback(async (id: string): Promise<void> => {
        await toggleTokenStatusMutation.mutateAsync(id);
    }, [toggleTokenStatusMutation]);

    // Revoke mutation - uses new API endpoint
    const revokeMutation = useMutation({
        mutationFn: async (tokenId: string): Promise<SubTokenRevokeResponse> => {
            if (!oauthSession?.token) {
                throw new Error('No authentication token available');
            }

            const response = await fetch(
                `${API_CONFIG.baseUrl}/api/objectstore/sub-tokens/${tokenId}/revoke/`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Token ${oauthSession.token}`,
                        Accept: 'application/json',
                    },
                }
            );

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(
                    errorData.detail || errorData.error || `Failed to revoke token: ${response.status}`
                );
            }

            return await response.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
            toast.success('Token revoked successfully');
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to revoke token');
        },
    });

    // Rotate mutation - uses new API endpoint
    const rotateMutation = useMutation({
        mutationFn: async (tokenId: string): Promise<SubTokenRotateResponse> => {
            if (!oauthSession?.token) {
                throw new Error('No authentication token available');
            }

            const response = await fetch(
                `${API_CONFIG.baseUrl}/api/objectstore/sub-tokens/${tokenId}/rotate/`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Token ${oauthSession.token}`,
                        Accept: 'application/json',
                    },
                }
            );

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(
                    errorData.detail || errorData.error || `Failed to rotate token: ${response.status}`
                );
            }

            return await response.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
            toast.success('Token rotated successfully');
        },
        onError: (error: Error) => {
            toast.error(error.message || 'Failed to rotate token');
        },
    });

    const revokeToken = useCallback(
        async (tokenId: string): Promise<SubTokenRevokeResponse> => {
            return await revokeMutation.mutateAsync(tokenId);
        },
        [revokeMutation]
    );

    const rotateToken = useCallback(
        async (tokenId: string): Promise<SubTokenRotateResponse> => {
            return await rotateMutation.mutateAsync(tokenId);
        },
        [rotateMutation]
    );

    return {
        tokens,
        isLoading: isLoading || createTokenMutation.isPending || updateTokenMutation.isPending || deleteTokenMutation.isPending || toggleTokenStatusMutation.isPending,
        isRefetching,
        refetch,
        createToken,
        updateToken,
        deleteToken,
        toggleTokenStatus,
        revokeToken,
        rotateToken,
        isRevoking: revokeMutation.isPending,
        isRotating: rotateMutation.isPending,
    };
}

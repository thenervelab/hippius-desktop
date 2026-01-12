"use client";

import React, { useState, useCallback } from "react";
import SearchInput from "@/components/ui/search-input";
import RefreshButton from "@/components/ui/refresh-button";
import CreateButton from "@/components/ui/button/CreateButton";
import { useApiTokens } from "@/lib/hooks/useApiTokens";
import { useMasterTokens } from "@/lib/hooks/useMasterTokens";
import ApiTokensTable from "./SubTokensTable";
import MasterTokensTable from "../master-tokens/MasterTokensTable";
import CreateTokenDialog from "./dialogs/CreateTokenDialog";
import TokenDetailsDialog from "./dialogs/TokenDetailsDialog";
import CreateMasterTokenDialog from "../dialogs/CreateMasterTokenDialog";
import TokenSecretDialog from "../dialogs/TokenSecretDialog";
import DeleteConfirmationDialog from "@/components/DeleteConfirmationDialog";
import { ApiToken, TokenPermission } from "@/app/lib/types/apiToken";
import { MasterToken, MasterTokenRotateResponse } from "@/app/lib/types/masterToken";
import { KeySquare } from "@/components/ui/icons";
import { Key } from "lucide-react";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import { BackButton } from "@/components/ui";

const ApiTokensContent = () => {
    const [activeTab, setActiveTab] = useState<string>("Sub Tokens");

    // Sub Tokens state
    const [apiSearchTerm, setApiSearchTerm] = useState("");
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [showTokenDetails, setShowTokenDetails] = useState(false);
    const [isTokenRotated, setIsTokenRotated] = useState(false);
    const [showRevokeApiTokenDialog, setShowRevokeApiTokenDialog] = useState(false);
    const [selectedApiToken, setSelectedApiToken] = useState<ApiToken | null>(null);
    const [createdToken, setCreatedToken] = useState<ApiToken | null>(null);

    // Master Tokens state
    const [masterSearchTerm, setMasterSearchTerm] = useState("");
    const [showCreateMasterDialog, setShowCreateMasterDialog] = useState(false);
    const [showSecretDialog, setShowSecretDialog] = useState(false);
    const [showRevokeDialog, setShowRevokeDialog] = useState(false);
    const [selectedMasterToken, setSelectedMasterToken] = useState<MasterToken | null>(null);
    const [rotatedTokenData, setRotatedTokenData] = useState<MasterTokenRotateResponse | null>(null);

    // Sub Tokens hook
    const {
        tokens,
        isLoading: isLoadingApiTokens,
        isRefetching: isRefetchingApiTokens,
        refetch: refetchApiTokens,
        createToken,
        revokeToken: revokeApiToken,
        rotateToken: rotateApiToken,
        isRevoking: isRevokingApiToken,
        isRotating: isRotatingApiToken,
    } = useApiTokens();

    // Track if Sub token is being created (derived from loading state)
    const [isCreatingApiToken, setIsCreatingApiToken] = React.useState(false);

    // Master Tokens hook
    const {
        tokens: masterTokens,
        isLoading: isLoadingMasterTokens,
        isRefetching: isRefetchingMasterTokens,
        refetch: refetchMasterTokens,
        create: createMasterToken,
        revoke: revokeMasterToken,
        rotate: rotateMasterToken,
        isCreating: isCreatingMasterToken,
        isRevoking: isRevokingMasterToken,
        isRotating: isRotatingMasterToken,
    } = useMasterTokens();

    // Tab options
    const tabs: TabOption[] = [
        {
            tabName: "Sub Tokens",
            icon: <Key className="size-4" />,
        },
        {
            tabName: "Master Tokens",
            icon: <KeySquare className="size-4" />,
        },
    ];

    // Filter Sub tokens based on search
    const filteredTokens = tokens.filter(
        (token) =>
            (token.name && token.name.toLowerCase().includes(apiSearchTerm.toLowerCase())) ||
            (token.permission && token.permission.toLowerCase().includes(apiSearchTerm.toLowerCase()))
    );

    // Filter Master tokens based on search
    const filteredMasterTokens = masterTokens.filter(
        (token) =>
            (token.name && token.name.toLowerCase().includes(masterSearchTerm.toLowerCase())) ||
            (token.access_key_id && token.access_key_id.toLowerCase().includes(masterSearchTerm.toLowerCase()))
    );

    // Sub Token handlers
    const handleCreateToken = useCallback(
        async (data: {
            tokenName: string;
            permission: string;
            applyToAll: boolean;
            selectedBuckets?: string[];
            lifespan: string;
            customDate?: Date;
        }) => {
            try {
                setIsCreatingApiToken(true);
                const newToken = await createToken({
                    name: data.tokenName,
                    permission: data.permission as TokenPermission,
                    applyToAll: data.applyToAll,
                    buckets: data.selectedBuckets,
                    lifespan: data.lifespan as "7 days" | "30 days" | "1 year" | "Forever" | "Custom",
                    customDate: data.customDate,
                });

                setCreatedToken(newToken);
                setShowCreateDialog(false);
                setIsTokenRotated(false);
                setShowTokenDetails(true);
            } catch (error) {
                console.error("Failed to create token:", error);
            } finally {
                setIsCreatingApiToken(false);
            }
        },
        [createToken]
    );

    // Sub Token Revoke handlers
    const handleRevokeApiTokenClick = useCallback((token: ApiToken) => {
        setSelectedApiToken(token);
        setShowRevokeApiTokenDialog(true);
    }, []);

    const handleConfirmRevokeApiToken = useCallback(async () => {
        if (!selectedApiToken) return;

        try {
            await revokeApiToken(selectedApiToken.id);
            setShowRevokeApiTokenDialog(false);
            setSelectedApiToken(null);
        } catch (error) {
            console.error("Failed to revoke token:", error);
        }
    }, [selectedApiToken, revokeApiToken]);

    // Sub Token Rotate handlers
    const handleRotateApiTokenClick = useCallback(
        async (token: ApiToken) => {
            try {
                const result = await rotateApiToken(token.id);
                // Merge original token with new credentials
                setCreatedToken({
                    ...token,
                    accessKeyId: result.access_key_id,
                    secretAccessKey: result.secret,
                });
                setIsTokenRotated(true);
                setShowTokenDetails(true);
            } catch (error) {
                console.error("Failed to rotate token:", error);
            }
        },
        [rotateApiToken]
    );

    // Master Token handlers
    const handleCreateMasterToken = useCallback(
        async (data: { name: string; expires_at: string }) => {
            const result = await createMasterToken(data);
            // Don't close the dialog here - let it stay open to show credentials
            return result;
        },
        [createMasterToken]
    );

    const handleRevokeClick = useCallback((token: MasterToken) => {
        setSelectedMasterToken(token);
        setShowRevokeDialog(true);
    }, []);

    const handleConfirmRevoke = useCallback(async () => {
        if (!selectedMasterToken) return;

        try {
            await revokeMasterToken(selectedMasterToken.id);
            setShowRevokeDialog(false);
            setSelectedMasterToken(null);
        } catch (error) {
            console.error("Failed to revoke token:", error);
        }
    }, [selectedMasterToken, revokeMasterToken]);

    const handleRotateClick = useCallback(
        async (token: MasterToken) => {
            try {
                const result = await rotateMasterToken(token.id);
                setRotatedTokenData(result);
                setShowSecretDialog(true);
            } catch (error) {
                console.error("Failed to rotate token:", error);
            }
        },
        [rotateMasterToken]
    );

    return (
        <div className="w-full">
            {/* Header Controls */}
            <div className="flex items-center gap-2 my-4">
                <BackButton onBack={() => window.history.back()} text="Back" />
            </div>

            {/* Tabs */}
            <div className="flex items-center justify-between flex-wrap gap-4 mt-6">
                <TabList
                    tabs={tabs}
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                />

                {/* Controls based on active tab */}
                <div className="flex items-center gap-4">
                    {activeTab === "Sub Tokens" ? (
                        <>
                            <SearchInput
                                placeholder="Search for a token"
                                className="h-9"
                                value={apiSearchTerm}
                                onChange={(value) => setApiSearchTerm(value)}
                            />
                            <RefreshButton refetching={isRefetchingApiTokens} onClick={refetchApiTokens} />
                            <CreateButton
                                text="New Token"
                                isLoading={isCreatingApiToken}
                                onClick={() => setShowCreateDialog(true)}
                            />
                        </>
                    ) : (
                        <>
                            <SearchInput
                                placeholder="Search for a token"
                                className="h-9"
                                value={masterSearchTerm}
                                onChange={(value) => setMasterSearchTerm(value)}
                            />
                            <RefreshButton refetching={isRefetchingMasterTokens} onClick={refetchMasterTokens} />
                            <CreateButton
                                text="New Master Token"
                                isLoading={isCreatingMasterToken}
                                onClick={() => setShowCreateMasterDialog(true)}
                            />
                        </>
                    )}
                </div>
            </div>

            {/* Content based on active tab */}
            {activeTab === "Sub Tokens" ? (
                <ApiTokensTable
                    tokens={filteredTokens}
                    isLoading={isLoadingApiTokens}
                    isRefetching={isRefetchingApiTokens || isRotatingApiToken}
                    onRevoke={handleRevokeApiTokenClick}
                    onRotate={handleRotateApiTokenClick}
                    hasActiveSearch={apiSearchTerm.length > 0}
                    searchTerm={apiSearchTerm}
                    onCreateToken={() => setShowCreateDialog(true)}
                />
            ) : (
                <MasterTokensTable
                    tokens={filteredMasterTokens}
                    isLoading={isLoadingMasterTokens}
                    isRefetching={isRefetchingMasterTokens || isRotatingMasterToken}
                    onRevoke={handleRevokeClick}
                    onRotate={handleRotateClick}
                    hasActiveSearch={masterSearchTerm.length > 0}
                    searchTerm={masterSearchTerm}
                    onCreateToken={() => setShowCreateMasterDialog(true)}
                />
            )}

            {/* Sub Token Dialogs */}
            <CreateTokenDialog
                open={showCreateDialog}
                onClose={() => setShowCreateDialog(false)}
                onSubmit={handleCreateToken}
                isCreating={isCreatingApiToken}
            />

            <TokenDetailsDialog
                open={showTokenDetails}
                onClose={() => {
                    setShowTokenDetails(false);
                    setCreatedToken(null);
                    setIsTokenRotated(false);
                }}
                token={createdToken}
                isRotated={isTokenRotated}
            />

            {/* Sub Token Revoke Dialog */}
            <DeleteConfirmationDialog
                open={showRevokeApiTokenDialog}
                onClose={() => {
                    setShowRevokeApiTokenDialog(false);
                    setSelectedApiToken(null);
                }}
                onBack={() => {
                    setShowRevokeApiTokenDialog(false);
                    setSelectedApiToken(null);
                }}
                onDelete={handleConfirmRevokeApiToken}
                button={isRevokingApiToken ? "Revoking..." : "Revoke Token"}
                text={`Are you sure you want to revoke the Sub token "${selectedApiToken?.name}"? This action cannot be undone and any applications using this token will lose access immediately.`}
                heading="Revoke Sub Token"
                disableButton={isRevokingApiToken}
            />

            {/* Master Token Dialogs */}
            <CreateMasterTokenDialog
                open={showCreateMasterDialog}
                onClose={(hasPendingOperations?: boolean) => {
                    if (!hasPendingOperations) {
                        setShowCreateMasterDialog(false);
                    }
                }}
                onCreateToken={handleCreateMasterToken}
                isCreating={isCreatingMasterToken}
            />

            <TokenSecretDialog
                open={showSecretDialog}
                onClose={() => {
                    setShowSecretDialog(false);
                    setRotatedTokenData(null);
                }}
                tokenData={rotatedTokenData}
            />

            <DeleteConfirmationDialog
                open={showRevokeDialog}
                onClose={() => {
                    setShowRevokeDialog(false);
                    setSelectedMasterToken(null);
                }}
                onBack={() => {
                    setShowRevokeDialog(false);
                    setSelectedMasterToken(null);
                }}
                onDelete={handleConfirmRevoke}
                button={isRevokingMasterToken ? "Revoking..." : "Revoke Token"}
                text={`Are you sure you want to revoke the master token "${selectedMasterToken?.name}"? This action cannot be undone and any applications using this token will lose access immediately.`}
                heading="Revoke Master Token"
                disableButton={isRevokingMasterToken}
            />
        </div>
    );
};

export default ApiTokensContent;

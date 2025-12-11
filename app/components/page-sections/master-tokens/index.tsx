"use client";

import React, { useState, useCallback } from "react";
import SearchInput from "@/components/ui/search-input";
import RefreshButton from "@/components/ui/refresh-button";
import CreateButton from "@/components/ui/button/CreateButton";
import { useMasterTokens } from "@/lib/hooks/useMasterTokens";
import MasterTokensTable from "./MasterTokensTable";
import CreateMasterTokenDialog from "../dialogs/CreateMasterTokenDialog";
import TokenSecretDialog from "../dialogs/TokenSecretDialog";
import DeleteConfirmationDialog from "@/components/DeleteConfirmationDialog";
import { MasterToken, MasterTokenRotateResponse } from "@/app/lib/types/masterToken";

const MasterTokensContent = () => {
    const [searchTerm, setSearchTerm] = useState("");
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [showSecretDialog, setShowSecretDialog] = useState(false);
    const [showRevokeDialog, setShowRevokeDialog] = useState(false);
    const [selectedToken, setSelectedToken] = useState<MasterToken | null>(null);
    const [rotatedTokenData, setRotatedTokenData] = useState<MasterTokenRotateResponse | null>(null);

    const {
        tokens,
        isLoading,
        isRefetching,
        refetch,
        create,
        revoke,
        rotate,
        isCreating,
        isRevoking,
        isRotating,
    } = useMasterTokens();

    // Filter tokens based on search
    const filteredTokens = tokens.filter(
        (token) =>
            (token.name && token.name.toLowerCase().includes(searchTerm.toLowerCase())) ||
            (token.access_key_id && token.access_key_id.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    const handleCreateToken = useCallback(
        async (data: { name: string; expires_at: string }) => {
            const result = await create(data);
            setShowCreateDialog(false);
            return result;
        },
        [create]
    );

    const handleRevokeClick = useCallback((token: MasterToken) => {
        setSelectedToken(token);
        setShowRevokeDialog(true);
    }, []);

    const handleConfirmRevoke = useCallback(async () => {
        if (!selectedToken) return;

        try {
            await revoke(selectedToken.id);
            setShowRevokeDialog(false);
            setSelectedToken(null);
        } catch (error) {
            console.error("Failed to revoke token:", error);
        }
    }, [selectedToken, revoke]);

    const handleRotateClick = useCallback(
        async (token: MasterToken) => {
            try {
                const result = await rotate(token.id);
                setRotatedTokenData(result);
                setShowSecretDialog(true);
            } catch (error) {
                console.error("Failed to rotate token:", error);
            }
        },
        [rotate]
    );

    return (
        <div className="w-full">
            {/* Header Controls */}
            <div className="flex items-center w-full justify-between flex-wrap gap-4">
                <div className="flex items-center gap-4">
                    <SearchInput
                        placeholder="Search for a token"
                        className="h-9"
                        value={searchTerm}
                        onChange={(value) => setSearchTerm(value)}
                    />
                    <RefreshButton refetching={isRefetching} onClick={() => { refetch(); }} />
                </div>
                <CreateButton
                    text="New Master Token"
                    isLoading={isCreating}
                    onClick={() => setShowCreateDialog(true)}
                />
            </div>

            {/* Table */}
            <MasterTokensTable
                tokens={filteredTokens}
                isLoading={isLoading}
                isRefetching={isRefetching || isRotating}
                onRevoke={handleRevokeClick}
                onRotate={handleRotateClick}
                hasActiveSearch={searchTerm.length > 0}
                searchTerm={searchTerm}
                onCreateToken={() => setShowCreateDialog(true)}
            />

            {/* Dialogs */}
            <CreateMasterTokenDialog
                open={showCreateDialog}
                onClose={() => setShowCreateDialog(false)}
                onCreateToken={handleCreateToken}
                isCreating={isCreating}
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
                    setSelectedToken(null);
                }}
                onBack={() => {
                    setShowRevokeDialog(false);
                    setSelectedToken(null);
                }}
                onDelete={handleConfirmRevoke}
                button={isRevoking ? "Revoking..." : "Revoke Token"}
                text={`Are you sure you want to revoke the master token "${selectedToken?.name}"? This action cannot be undone and any applications using this token will lose access immediately.`}
                heading="Revoke Master Token"
                disableButton={isRevoking}
            />
        </div>
    );
};

export default MasterTokensContent;

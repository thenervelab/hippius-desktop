"use client";

import { FC } from "react";
import ApiTokensContent from "@/components/page-sections/api-tokens";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import InfoTooltip from "@/components/ui/InfoTooltip";

const tokenManagementTooltip = (
    <InfoTooltip>
        Manage your S3 access tokens. Master tokens are required for bucket operations
        and can be used to create API tokens with granular permissions for specific buckets.
        <br />
        <a
            href="https://docs.hippius.com/use/s3-token-management"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-50 hover:underline"
        >
            View full documentation
        </a>
    </InfoTooltip>
);

const TokensPage: FC = () => {
    return (
        <DashboardTitleWrapper mainText="Token Management" infoTooltip={tokenManagementTooltip}>
            <ApiTokensContent />
        </DashboardTitleWrapper>
    );
};

export default TokensPage;

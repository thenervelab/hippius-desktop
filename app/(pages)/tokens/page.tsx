"use client";

import { FC } from "react";
import ApiTokensContent from "@/components/page-sections/api-tokens";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";

const TokensPage: FC = () => {
    return (
        <DashboardTitleWrapper mainText="Token Management">
            <ApiTokensContent />
        </DashboardTitleWrapper>
    );
};

export default TokensPage;

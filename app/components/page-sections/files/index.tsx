"use client";

import React from "react";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import Ipfs from "./FilesContainer";

export default function Files() {
    return (
        <>
            <DashboardTitleWrapper mainText="Your Files">
                <Ipfs />
            </DashboardTitleWrapper>
        </>
    );
}

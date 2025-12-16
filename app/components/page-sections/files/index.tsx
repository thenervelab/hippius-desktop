"use client";

import React from "react";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import FilesContainer from "./FilesContainer";

export default function Files() {
    return (
        <>
            <DashboardTitleWrapper mainText="Your Files">
                <FilesContainer />
            </DashboardTitleWrapper>
        </>
    );
}

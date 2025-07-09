"use client";

import React from "react";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import Ipfs from "./ipfs";

export default function Files() {
    return (
        <>
            <DashboardTitleWrapper mainText="">
                <Ipfs />
            </DashboardTitleWrapper>
        </>
    );
}

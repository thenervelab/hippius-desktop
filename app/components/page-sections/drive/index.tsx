"use client";

import React from "react";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import DriveContainer from "./DriveContainer";

export default function Drive() {
  return (
    <>
      <DashboardTitleWrapper mainText="My Drive">
        <DriveContainer />
      </DashboardTitleWrapper>
    </>
  );
}

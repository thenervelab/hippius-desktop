"use client";
import DashboardTitleWrapper from "../components/dashboard-title-wrapper";
import HomePage from "../components/page-sections/home";
export default function Home() {
  return (
    <DashboardTitleWrapper mainText="">
      <HomePage />
    </DashboardTitleWrapper>
  );
}

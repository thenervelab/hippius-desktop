import Support from "@/app/components/page-sections/support";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hippius Console - Support",
  description: "View and manage your support tickets",
};

const SupportPage: React.FC = () => (
  <DashboardTitleWrapper mainText="Help and Support">
    <Support />
  </DashboardTitleWrapper>
);

export default SupportPage;

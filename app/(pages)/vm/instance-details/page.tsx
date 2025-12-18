import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import InstanceDetails from "@/components/vm/instance-details";

import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hippius Console - VM Instance Details",
  description: "Manage your virtual machine instance",
};

export default function InstanceDetailsPage() {
  return (
    <DashboardTitleWrapper mainText="Virtual Machines">
      <div className="mt-6">
        <InstanceDetails />
      </div>
    </DashboardTitleWrapper>
  );
}

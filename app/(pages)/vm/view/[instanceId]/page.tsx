import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import InstanceDetails from "@/components/vm/instance-details";
import { MOCK_INSTANCES } from "@/components/vm/instances-table/mock-data";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hippius Console - VM Instance Details",
  description: "Manage your virtual machine instance",
};

// Pre-render all instance detail pages to satisfy static export requirements
export function generateStaticParams() {
  return MOCK_INSTANCES.map(({ id }) => ({
    instanceId: id,
  }));
}

export const dynamicParams = false;

export default function InstanceDetailsPage() {
  return (
    <DashboardTitleWrapper mainText="Virtual Machines">
      <div className="mt-6">
        <InstanceDetails />
      </div>
    </DashboardTitleWrapper>
  );
}

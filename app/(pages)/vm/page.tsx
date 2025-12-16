import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import VirtualMachines from "@/components/vm";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hippius Console - Virtual Machines",
  description: "Manage your virtual machines and instances",
};

export default function VirtualMachinePage() {
  return (
    <DashboardTitleWrapper mainText="Virtual Machines">
      <div className="mt-6">
        <VirtualMachines />
      </div>
    </DashboardTitleWrapper>
  );
}

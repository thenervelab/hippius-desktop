import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import VirtualMachines from "@/components/vm";
import FeatureDisabledRedirect from "@/components/FeatureDisabledRedirect";
import { VM_FEATURE_ENABLED } from "@/app/lib/featureFlags";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hippius Console - Virtual Machines",
  description: "Manage your virtual machines and instances",
};

export default function VirtualMachinePage() {
  return (
    <FeatureDisabledRedirect enabled={VM_FEATURE_ENABLED}>
      <DashboardTitleWrapper
        mainText="Virtual Machines"
        subText="All virtual machines run in isolated enclaves with hardware-level encryption"
      >
        <div>
          <VirtualMachines />
        </div>
      </DashboardTitleWrapper>
    </FeatureDisabledRedirect>
  );
}

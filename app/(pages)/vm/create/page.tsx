import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import CreateVM from "@/components/vm/create-vm";
import FeatureDisabledRedirect from "@/components/FeatureDisabledRedirect";
import { VM_FEATURE_ENABLED } from "@/app/lib/featureFlags";

export default function CreateVMPage() {
  return (
    <FeatureDisabledRedirect enabled={VM_FEATURE_ENABLED}>
      <DashboardTitleWrapper
        mainText="Virtual Machines"
        subText="All virtual machines run in isolated enclaves with hardware-level encryption"
      >
        <div className="p-3">
          <CreateVM />
        </div>
      </DashboardTitleWrapper>
    </FeatureDisabledRedirect>
  );
}

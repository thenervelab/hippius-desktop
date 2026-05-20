import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import CreateVM from "@/components/vm/create-vm";

export default function CreateVMPage() {
  return (
    <DashboardTitleWrapper
      mainText="Virtual Machines"
      subText="All virtual machines run in isolated enclaves with hardware-level encryption"
    >
      <div className="p-3">
        <CreateVM />
      </div>
    </DashboardTitleWrapper>
  );
}

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import CreateVM from "@/components/vm/create-vm";

export default function CreateVMPage() {
  return (
    <DashboardTitleWrapper mainText="Virtual Machines">
      <CreateVM />
    </DashboardTitleWrapper>
  );
}

import React, { useState } from "react";
import InfoPanel from "./info-panel";
import LabelWithIcon from "./label-with-icon";
import { Instance } from "../instances-table";
import ImageCell from "../instances-table/image-cell";
import StatusCell from "../instances-table/status-cell";
import TemplateItem from "@/components/vm/instance-details/template-item";
import { Button } from "@/components/ui/button";
import { Button as NewButton } from "@/components/ui/button/NewButton";
import { MoreVertical } from "lucide-react";
import { toast } from "sonner";
import ChangeImageModal, { ChangeImageData } from "./change-image-modal";
import { useDeleteInstance } from "../hooks/useDeleteInstance";
import { useStartStopInstance } from "../hooks/useStartStopInstance";
import { useRebootInstance } from "../hooks/useRebootInstance";
import { useReinstallInstance } from "../hooks/useReinstallInstance";
import { Icons } from "../../ui";
import ConfirmDialog2 from "../../ui/ConfirmDialog2";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import CopyableText from "../../ui/CopyableText";

interface VirtualMachineInfoProps {
  instance: Instance;
}

const VirtualMachineInfo: React.FC<VirtualMachineInfoProps> = ({
  instance,
}) => {
  const [openChangeImageModal, setOpenChangeImageModal] = useState(false);
  const [openChangeInstanceModal, setOpenChangeInstanceModal] = useState(false);

  // Use delete instance hook with redirect
  const { handleDeleteInstance, DeleteInstanceModal } = useDeleteInstance({
    redirectOnDelete: true,
  });

  // Use start/stop instance hook
  const { handleStartStopInstance, StartStopConfirmModal } =
    useStartStopInstance();

  // Use reboot instance hook
  const { handleRebootInstance, RebootConfirmModal } = useRebootInstance();

  // Use reinstall instance hook
  const { handleReinstallInstance, ReinstallConfirmModal } =
    useReinstallInstance();

  // Extended instance data for the mock
  const extendedInfo = {
    model: "B3-32-FLEX",
    ram: "32 GB",
    processor: "8 vCores",
    storage: "200 GB",
    bandwidth: "200 Mbps",
  };

  const handleChangeImage = (data: ChangeImageData) => {
    setOpenChangeImageModal(false);
    setOpenChangeInstanceModal(true);
  };

  const handleConfirmChangeInstance = () => {
    setOpenChangeInstanceModal(false);
    toast.success("Instance Image Changed Successfully");
  };

  const vmControlsMenu = (
    <TableActionMenu
      dropdownTitle="VM Controls"
      items={[
        {
          icon:
            instance.status === "Stopped" ? (
              <Icons.PlayCircle className="size-4" />
            ) : (
              <Icons.StopCircle className="size-4" />
            ),
          itemTitle:
            instance.status === "Stopped" ? "Start Instance" : "Stop Instance",
          onItemClick: () => handleStartStopInstance(instance, instance.status),
        },
        {
          icon: <Icons.Refresh2 className="size-4" />,
          itemTitle: "Reboot Instance",
          onItemClick: () => handleRebootInstance(instance),
        },
        {
          icon: <Icons.Refresh className="size-4" />,
          itemTitle: "Reinstall Instance",
          onItemClick: () => handleReinstallInstance(instance),
        },
        {
          icon: <Icons.Trash className="size-4" />,
          itemTitle: "Delete Instance",
          onItemClick: () => handleDeleteInstance(instance),
          variant: "destructive",
        },
      ]}
    >
      <NewButton
        variant="ghost"
        size="noStyle"
        className="px-1.5 py-1 flex gap-1 text-grey-10 border border-grey-80"
      >
        <span className="text-sm">VM Controls</span>
        <MoreVertical className="size-4" />
      </NewButton>
    </TableActionMenu>
  );

  return (
    <>
      <InfoPanel
        title="Virtual Machine Information"
        icon={<Icons.Driver className="size-[18px] relative text-primary-50" />}
        headerAction={vmControlsMenu}
      >
        {/* Miner ID */}
        <div className="mb-6">
          <LabelWithIcon
            icon={<Icons.UserSquare className="size-4" />}
            label="Miner ID"
          />
          <div className="mt-1">
            <CopyableText
              value={instance.minerId}
              displayMode="truncate"
              textClassName="text-grey-10 font-medium text-base"
              iconClassName="text-grey-50 p-1 bg-grey-90 rounded w-6 h-6"
              maxWidth="w-full"
            />
          </div>
        </div>

        {/* Image */}
        <div className="mb-6">
          <LabelWithIcon
            icon={<Icons.CpuCharge className="size-4" />}
            label="Image"
          />
          <div className="mt-1 flex justify-between gap-2">
            <ImageCell
              iconClass="bg-[#F7F7F7] p-[5px] size-[26px]"
              value={instance.image}
            />
            <NewButton
              variant="ghost"
              size="noStyle"
              className="px-1.5 py-1 flex gap-1 text-grey-50 border border-grey-80"
              onClick={() => setOpenChangeImageModal(true)}
            >
              <Icons.Refresh2 className="size-4" />
              <span className="text-sm">Change Image</span>
            </NewButton>
          </div>
        </div>

        {/* Status */}
        <div className="mb-6">
          <LabelWithIcon
            icon={<Icons.Status className="size-4" />}
            label="Status"
          />
          <div className="mt-1">
            <StatusCell
              className="p-2 bg-[#F7F7F7] w-min"
              value={instance.status}
            />
          </div>
        </div>

        {/* Template */}
        <div>
          <LabelWithIcon
            icon={<Icons.Setting className="size-4" />}
            label="Template"
          />
          <div className="grid grid-cols-2 gap-2 ">
            <TemplateItem label="Model" value={extendedInfo.model} />
            <TemplateItem label="RAM" value={extendedInfo.ram} />
            <TemplateItem label="Processor" value={extendedInfo.processor} />
            <TemplateItem label="Storage" value={extendedInfo.storage} />
            <TemplateItem
              label="Public Bandwidth"
              className="col-span-2"
              value={extendedInfo.bandwidth}
            />
          </div>
        </div>
      </InfoPanel>
      <ChangeImageModal
        open={openChangeImageModal}
        onClose={() => setOpenChangeImageModal(false)}
        onSubmit={handleChangeImage}
      />

      <ConfirmDialog2
        open={openChangeInstanceModal}
        onClose={() => setOpenChangeInstanceModal(false)}
        onConfirm={handleConfirmChangeInstance}
        onBack={() => setOpenChangeInstanceModal(false)}
        button="Change Instance"
        text="Are you sure you want to change this instance? This action will overwrite the instance"
        heading="Change Instance"
        icon={<Icons.Refresh2 className="size-6 text-grey-100" />}
        iconBgColor="bg-primary-50"
      />

      <DeleteInstanceModal />

      <StartStopConfirmModal />

      <RebootConfirmModal />

      <ReinstallConfirmModal />
    </>
  );
};

export default VirtualMachineInfo;

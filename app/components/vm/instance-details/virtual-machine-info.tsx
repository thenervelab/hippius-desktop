import React, { useState } from "react";
import InfoPanel from "./info-panel";
import LabelWithIcon from "./label-with-icon";
import ImageCell from "../instances-table/image-cell";
import StatusCell from "../instances-table/status-cell";
import TemplateItem from "@/components/vm/instance-details/template-item";
import { Button as NewButton } from "@/components/ui/button/NewButton";
import { MoreVertical } from "lucide-react";
import { toast } from "sonner";
import ChangeImageModal, { ChangeImageData } from "./change-image-modal";
import { useDeleteInstance } from "../hooks/useDeleteInstance";
import { useStartStopInstance } from "../hooks/useStartStopInstance";
import { useRebootInstance } from "../hooks/useRebootInstance";
import { Icons } from "../../ui";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { VMInstanceDetailsResponse } from "@/app/lib/hooks/api/useVMInstanceDetails";
import Skeleton from "@/components/ui/skeleton";

interface VirtualMachineInfoProps {
  instanceData?: VMInstanceDetailsResponse;
  isLoading: boolean;
  onRefresh?: () => void;
}

const VirtualMachineInfo: React.FC<VirtualMachineInfoProps> = ({
  instanceData,
  isLoading,
  onRefresh,
}) => {
  const [openChangeImageModal, setOpenChangeImageModal] = useState(false);
  const [openChangeInstanceModal, setOpenChangeInstanceModal] = useState(false);

  // Use delete instance hook with redirect
  const { handleDeleteInstance, DeleteInstanceModal } = useDeleteInstance({
    redirectOnDelete: true,
  });

  // Use start/stop instance hook with refresh callback
  const { handleStartStopInstance, StartStopConfirmModal } =
    useStartStopInstance({
      onSuccess: onRefresh,
    });

  // Use reboot instance hook with refresh callback
  const { handleRebootInstance, RebootConfirmModal } = useRebootInstance({
    onSuccess: onRefresh,
  });

  // Parse image name for ImageCell
  const parseImageName = (imageName: string) => {
    let os:
      | "AlmaLinux"
      | "CentOS"
      | "Debian"
      | "Fedora"
      | "Rocky Linux"
      | "Ubuntu";
    let version: string;

    if (imageName.startsWith("AlmaLinux")) {
      os = "AlmaLinux";
      version = imageName;
    } else if (imageName.startsWith("CentOS")) {
      os = "CentOS";
      version = imageName;
    } else if (imageName.startsWith("Debian")) {
      os = "Debian";
      version = imageName;
    } else if (imageName.startsWith("Fedora")) {
      os = "Fedora";
      version = imageName;
    } else if (imageName.startsWith("Rocky Linux")) {
      os = "Rocky Linux";
      version = imageName;
    } else if (imageName.startsWith("Ubuntu")) {
      os = "Ubuntu";
      version = imageName;
    } else {
      os = "Ubuntu";
      version = imageName;
    }

    return { os, version };
  };

  const handleChangeImage = (data: ChangeImageData) => {
    console.log("Change Image Data:", data);
    setOpenChangeImageModal(false);
    setOpenChangeInstanceModal(true);
  };

  const handleConfirmChangeInstance = () => {
    setOpenChangeInstanceModal(false);
    toast.success("Instance Image Changed Successfully");
  };

  const vmControlsMenu = instanceData ? (
    <TableActionMenu
      dropdownTitle="VM Controls"
      disabled={isLoading}
      items={[
        {
          icon:
            instanceData.status.toLowerCase() === "stopped" ? (
              <Icons.PlayCircle className="size-4" />
            ) : (
              <Icons.StopCircle className="size-4" />
            ),
          disabled:
            instanceData.status.toLowerCase() !== "running" &&
            instanceData.status.toLowerCase() !== "stopped",
          itemTitle:
            instanceData.status.toLowerCase() === "stopped"
              ? "Start Instance"
              : "Stop Instance",
          onItemClick: () =>
            handleStartStopInstance(
              {
                id: instanceData.id,
                uuid: instanceData.uuid,
                name: instanceData.name,
                status: instanceData.status,
                flavor: instanceData.flavor.name,
                image: instanceData.image,
                public_ip: instanceData.public_ip,
                nebula_ip: instanceData.nebula_ip,
                created_at: instanceData.created_at,
              },
              instanceData.status
            ),
        },
        {
          icon: <Icons.Refresh2 className="size-4" />,
          itemTitle: "Reboot Instance",
          disabled: instanceData.status.toLowerCase() !== "running",
          onItemClick: () =>
            handleRebootInstance({
              id: instanceData.id,
              uuid: instanceData.uuid,
              name: instanceData.name,
              status: instanceData.status,
              flavor: instanceData.flavor.name,
              image: instanceData.image,
              public_ip: instanceData.public_ip,
              nebula_ip: instanceData.nebula_ip,
              created_at: instanceData.created_at,
            }),
        },
        {
          icon: <Icons.Trash className="size-4" />,
          itemTitle: "Delete Instance",
          onItemClick: () =>
            handleDeleteInstance({
              id: instanceData.id,
              uuid: instanceData.uuid,
              name: instanceData.name,
              status: instanceData.status,
              flavor: instanceData.flavor.name,
              image: instanceData.image,
              public_ip: instanceData.public_ip,
              nebula_ip: instanceData.nebula_ip,
              created_at: instanceData.created_at,
            }),
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
  ) : null;

  return (
    <>
      <InfoPanel
        title="Virtual Machine Information"
        icon={<Icons.Driver className="size-[1.125rem] relative text-primary-50" />}
        headerAction={vmControlsMenu}
      >
        {/* Miner ID
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
        </div> */}

        {/* Image */}
        <div className="mb-6">
          <LabelWithIcon
            icon={<Icons.CpuCharge className="size-4" />}
            label="Image"
          />
          <div className="mt-1 flex justify-between gap-2">
            {isLoading ? (
              <Skeleton className="!h-[1.625rem] !w-[9.375rem]" />
            ) : instanceData ? (
              <ImageCell
                iconClass="bg-[#F7F7F7] p-[0.3125rem] size-[1.625rem]"
                value={parseImageName(instanceData.image)}
              />
            ) : null}
            {/* <NewButton
              variant="ghost"
              size="noStyle"
              className="px-1.5 py-1 flex gap-1 text-grey-50 border border-grey-80"
              onClick={() => setOpenChangeImageModal(true)}
            >
              <Icons.Refresh2 className="size-4" />
              <span className="text-sm">Change Image</span>
            </NewButton> */}
          </div>
        </div>

        {/* Status */}
        <div className="mb-6">
          <LabelWithIcon
            icon={<Icons.Status className="size-4" />}
            label="Status"
          />
          <div className="mt-1">
            {isLoading ? (
              <Skeleton className="!h-[1.5625rem] !w-[9.375rem]" />
            ) : instanceData ? (
              <StatusCell
                className="p-2 bg-[#F7F7F7] w-min"
                value={instanceData.status}
              />
            ) : null}
          </div>
        </div>

        {/* Template */}
        <div className="mb-6">
          <LabelWithIcon
            icon={<Icons.Setting className="size-4" />}
            label="Template"
          />
          <div className="grid grid-cols-2 gap-2 ">
            {isLoading ? (
              <>
                <div className="bg-[#F7F7F7] p-2 rounded">
                  <div className="text-grey-50 font-medium text-base">
                    Model
                  </div>
                  <Skeleton className="!h-[1.25rem] !w-[5rem] mt-2" />
                </div>
                <div className="bg-[#F7F7F7] p-2 rounded">
                  <div className="text-grey-50 font-medium text-base">RAM</div>
                  <Skeleton className="!h-[1.25rem] !w-[5rem] mt-2" />
                </div>
                <div className="bg-[#F7F7F7] p-2 rounded">
                  <div className="text-grey-50 font-medium text-base">
                    Processor
                  </div>
                  <Skeleton className="!h-[1.25rem] !w-[5rem] mt-2" />
                </div>
                <div className="bg-[#F7F7F7] p-2 rounded">
                  <div className="text-grey-50 font-medium text-base">
                    Storage
                  </div>
                  <Skeleton className="!h-[1.25rem] !w-[5rem] mt-2" />
                </div>
              </>
            ) : instanceData ? (
              <>
                <TemplateItem label="Model" value={instanceData.flavor.name} />
                <TemplateItem
                  label="RAM"
                  value={`${(instanceData.flavor.memory_mb / 1024).toFixed(
                    0
                  )} GB`}
                />
                <TemplateItem
                  label="Processor"
                  value={`${instanceData.flavor.cpu_cores} vCore${
                    instanceData.flavor.cpu_cores > 1 ? "s" : ""
                  }`}
                />
                <TemplateItem
                  label="Storage"
                  value={`${instanceData.flavor.disk_gb} GB`}
                />
              </>
            ) : null}
          </div>
        </div>

        {/* Created At */}
        <div>
          <LabelWithIcon
            icon={<Icons.Calendar className="size-4" />}
            label="Created At"
          />
          <div className="mt-1">
            {isLoading ? (
              <Skeleton className="!h-[1.25rem] !w-[12.5rem]" />
            ) : instanceData ? (
              <div className="text-grey-10 font-medium text-base">
                {new Date(instanceData.created_at).toLocaleString()}
              </div>
            ) : null}
          </div>
        </div>
      </InfoPanel>
      <ChangeImageModal
        open={openChangeImageModal}
        onClose={() => setOpenChangeImageModal(false)}
        onSubmit={handleChangeImage}
      />

      <ConfirmDialog
        mode="branded"
        open={openChangeInstanceModal}
        onCancel={() => setOpenChangeInstanceModal(false)}
        onBack={() => setOpenChangeInstanceModal(false)}
        onConfirm={handleConfirmChangeInstance}
        confirmText="Change Instance"
        description="Are you sure you want to change this instance? This action will overwrite the instance"
        title="Change Instance"
        icon={<Icons.Refresh2 className="size-6 text-grey-100" />}
        iconBgColor="bg-primary-50"
      />

      <DeleteInstanceModal />

      <StartStopConfirmModal />

      <RebootConfirmModal />
    </>
  );
};

export default VirtualMachineInfo;

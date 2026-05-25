import React from "react";
import InfoPanel from "./info-panel";
import { Button, Icons } from "../../ui";
import { VMInstanceDetailsResponse } from "@/app/lib/hooks/api/useVMInstanceDetails";
import Skeleton from "@/components/ui/skeleton";
import { CopyableCell } from "../../ui/alt-table";
import { useDeleteInstance } from "../hooks/useDeleteInstance";
import { useRebootInstance } from "../hooks/useRebootInstance";

interface NetworksInfoProps {
  instanceData?: VMInstanceDetailsResponse;
  isLoading: boolean;
  onRefresh?: () => void;
}

const CONTROL_BUTTON_CLASS =
  "h-[33px] flex-1 gap-[8px] rounded-[7px] border border-grey-dark-100 bg-grey-light-100 px-[20px] text-[14px] font-medium leading-[20px] tracking-[-0.28px] text-black-700 hover:bg-grey-90 dark:border-black-300 dark:bg-black-500 dark:text-grey-light-300 dark:hover:bg-black-400";

const NetworksInfo: React.FC<NetworksInfoProps> = ({
  instanceData,
  isLoading,
  onRefresh,
}) => {
  const { handleDeleteInstance, DeleteInstanceModal } = useDeleteInstance({
    redirectOnDelete: true,
  });
  const { handleRebootInstance, RebootConfirmModal } = useRebootInstance({
    onSuccess: onRefresh,
  });

  const statusLower = instanceData?.status.toLowerCase();
  const canReboot = statusLower === "running";

  const instanceForActions = instanceData
    ? {
        id: instanceData.id,
        uuid: instanceData.uuid,
        name: instanceData.name,
        status: instanceData.status,
        flavor: instanceData.flavor.name,
        image: instanceData.image,
        public_ip: instanceData.public_ip,
        nebula_ip: instanceData.nebula_ip || null,
        created_at: instanceData.created_at,
      }
    : null;

  return (
    <div className="flex flex-col gap-[10px]">
      <h2 className="text-[18px] font-medium leading-normal text-black-700 dark:text-grey-light-100">
        Network &amp; others
      </h2>

      <div className="flex flex-col gap-[10px]">
        <InfoPanel
          label="SSH Key"
          icon={<Icons.FileKey className="size-[18px]" />}
          bodyClassName="h-[44px] py-0 flex items-center"
        >
          {isLoading ? (
            <Skeleton className="!h-[20px] !w-[260px] dark:!bg-black-300" />
          ) : (
            <CopyableCell
              title="Copy Public Key"
              toastMessage="Public Key Copied Successfully!"
              copyAbleText={
                instanceData?.ssh_public_key ? instanceData.ssh_public_key : "—"
              }
              numberOfCharactersFromStartAndEnd={30}
              className="w-full text-[14px] font-medium leading-[22px] tracking-[-0.28px] text-black-700 dark:text-grey-light-300"
              textColor="text-black-700 dark:text-grey-light-300"
              copyIconClassName="text-grey-dark-800 dark:text-grey-dark-600 p-1 bg-grey-light-500 dark:bg-black-400 rounded w-6 h-6"
              checkIconClassName="text-grey-dark-800 dark:text-grey-dark-600 p-1 bg-grey-light-500 dark:bg-black-400 rounded w-6 h-6"
            />
          )}
        </InfoPanel>

        <InfoPanel
          label="Nebula IP"
          icon={<Icons.Cloud className="size-[18px]" />}
          bodyClassName="h-[44px] py-0 flex items-center"
        >
          {isLoading ? (
            <Skeleton className="!h-[20px] !w-[140px] dark:!bg-black-300" />
          ) : (
            <CopyableCell
              title="Copy Nebula IP"
              toastMessage="Nebula IP Copied Successfully!"
              copyAbleText={instanceData?.nebula_ip || "—"}
              className="w-full text-[14px] font-medium leading-[22px] tracking-[-0.28px] text-black-700 dark:text-grey-light-300"
              textColor="text-black-700 dark:text-grey-light-300"
              copyIconClassName="text-grey-dark-800 dark:text-grey-dark-600 p-1 bg-grey-light-500 dark:bg-black-400 rounded w-6 h-6"
              checkIconClassName="text-grey-dark-800 dark:text-grey-dark-600 p-1 bg-grey-light-500 dark:bg-black-400 rounded w-6 h-6"
            />
          )}
        </InfoPanel>

        <InfoPanel
          label="VM Controls"
          icon={<Icons.Loader2 className="size-[18px]" />}
          bodyClassName="h-[59px] py-0 flex items-center"
        >
          <div className="flex w-full gap-[12px]">
            <Button
              variant="defaultStable"
              size="noStyle"
              className={CONTROL_BUTTON_CLASS}
              disabled={!instanceForActions || !canReboot || isLoading}
              onClick={() =>
                instanceForActions && handleRebootInstance(instanceForActions)
              }
            >
              <Icons.Refresh2 className="size-4" />
              Reboot Instance
            </Button>
            <Button
              variant="defaultStable"
              size="noStyle"
              className={CONTROL_BUTTON_CLASS}
              disabled={!instanceForActions || isLoading}
              onClick={() =>
                instanceForActions && handleDeleteInstance(instanceForActions)
              }
            >
              <Icons.Trash className="size-4 text-error-50" />
              Delete Instance
            </Button>
          </div>
        </InfoPanel>
      </div>

      <DeleteInstanceModal />
      <RebootConfirmModal />
    </div>
  );
};

export default NetworksInfo;

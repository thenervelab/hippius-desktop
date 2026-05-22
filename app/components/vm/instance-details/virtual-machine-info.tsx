import React from "react";
import { cn } from "@/lib/utils";
import InfoPanel from "./info-panel";
import ImageCell from "../instances-table/image-cell";
import { parseImageName } from "@/lib/utils/vmUtils";
import TemplateItem from "@/components/vm/instance-details/template-item";
import { Button, Icons } from "../../ui";
import { useStartStopInstance } from "../hooks/useStartStopInstance";
import { VMInstanceDetailsResponse } from "@/app/lib/hooks/api/useVMInstanceDetails";
import Skeleton from "@/components/ui/skeleton";

interface VirtualMachineInfoProps {
  instanceData?: VMInstanceDetailsResponse;
  isLoading: boolean;
  onRefresh?: () => void;
}

const STATUS_DOT_COLOR: Record<string, string> = {
  running: "bg-success-40",
  connected: "bg-success-40",
  stopped: "bg-warning-50",
  starting: "bg-primary-50",
  stopping: "bg-[#BA66FF]",
  pending: "bg-grey-dark-600",
  spawning: "bg-grey-dark-600",
  failed: "bg-error-50",
  error: "bg-error-50",
};

const StatusBadge: React.FC<{ value: string }> = ({ value }) => {
  const normalized = value.toLowerCase();
  const dotColor = STATUS_DOT_COLOR[normalized] ?? "bg-grey-dark-600";
  const label = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  return (
    <div className="inline-flex items-center gap-[6px] rounded-[4px] bg-grey-light-500 px-[8px] py-[4px] dark:bg-black-500">
      <span className={cn("size-[8px] rounded-full", dotColor)} />
      <span className="text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-black-700 dark:text-grey-light-300">
        {label}
      </span>
    </div>
  );
};

const ACTION_BUTTON_CLASS =
  "h-[30px] gap-[6px] rounded-[7px] border border-grey-dark-100 bg-grey-light-100 px-[10px] text-[14px] font-medium leading-[20px] tracking-[-0.28px] text-black-700 hover:bg-grey-90 dark:border-black-300 dark:bg-black-500 dark:text-grey-light-300 dark:hover:bg-black-400";

const VirtualMachineInfo: React.FC<VirtualMachineInfoProps> = ({
  instanceData,
  isLoading,
  onRefresh,
}) => {
  const { handleStartStopInstance, StartStopConfirmModal } =
    useStartStopInstance({
      onSuccess: onRefresh,
    });

  const statusLower = instanceData?.status.toLowerCase();
  const isStopped = statusLower === "stopped";
  const canToggle = statusLower === "running" || statusLower === "stopped";

  const handleToggle = () => {
    if (!instanceData) return;
    handleStartStopInstance(
      {
        id: instanceData.id,
        uuid: instanceData.uuid,
        name: instanceData.name,
        status: instanceData.status,
        flavor: instanceData.flavor.name,
        image: instanceData.image,
        public_ip: instanceData.public_ip,
        nebula_ip: instanceData.nebula_ip || null,
        created_at: instanceData.created_at,
      },
      instanceData.status,
    );
  };

  const statusAction = instanceData ? (
    <Button
      variant="defaultStable"
      size="noStyle"
      className={ACTION_BUTTON_CLASS}
      disabled={!canToggle || isLoading}
      onClick={handleToggle}
    >
      {isStopped ? (
        <Icons.PlayCircle className="size-4" />
      ) : (
        <Icons.StopCircle className="size-4" />
      )}
      {isStopped ? "Start" : "Stop"}
    </Button>
  ) : null;

  return (
    <div className="flex flex-col gap-[10px]">
      <h2 className="text-[18px] font-medium leading-normal text-black-700 dark:text-grey-light-100">
        Virtual Machine Information
      </h2>

      <div className="flex flex-col gap-[10px]">
        <div className="grid grid-cols-1 @sm:grid-cols-2 gap-[10px]">
          <InfoPanel
            label="Image"
            icon={<Icons.Microchip className="size-[18px]" />}
            bodyClassName="h-[44px] py-0 flex items-center"
          >
            {isLoading ? (
              <Skeleton className="!h-[20px] !w-[150px] dark:!bg-black-300" />
            ) : instanceData ? (
              <ImageCell value={parseImageName(instanceData.image)} />
            ) : null}
          </InfoPanel>

          <InfoPanel
            label="Status"
            icon={<Icons.DashedCircle className="size-[18px]" />}
            action={statusAction}
            bodyClassName="h-[44px] py-0 flex items-center"
          >
            {isLoading ? (
              <Skeleton className="!h-[20px] !w-[80px] dark:!bg-black-300" />
            ) : instanceData ? (
              <StatusBadge value={instanceData.status} />
            ) : null}
          </InfoPanel>
        </div>

        <InfoPanel
          label="Model"
          icon={<Icons.GripTriple className="size-[18px]" />}
          bodyClassName="h-[161px] py-0 flex flex-col justify-center"
        >
          <div className="flex flex-col gap-[12px]">
            <div className="flex gap-[8px]">
              <TemplateItem
                label="Model"
                value={
                  isLoading ? (
                    <Skeleton className="!h-[20px] !w-[80px] dark:!bg-black-300" />
                  ) : (
                    (instanceData?.flavor.name ?? "—")
                  )
                }
              />
              <TemplateItem
                label="RAM"
                value={
                  isLoading ? (
                    <Skeleton className="!h-[20px] !w-[60px] dark:!bg-black-300" />
                  ) : instanceData ? (
                    `${(instanceData.flavor.memory_mb / 1024).toFixed(0)} GB`
                  ) : (
                    "—"
                  )
                }
              />
            </div>
            <div className="flex gap-[8px]">
              <TemplateItem
                label="Processor"
                value={
                  isLoading ? (
                    <Skeleton className="!h-[20px] !w-[80px] dark:!bg-black-300" />
                  ) : instanceData ? (
                    `${instanceData.flavor.cpu_cores} vCore${
                      instanceData.flavor.cpu_cores > 1 ? "s" : ""
                    }`
                  ) : (
                    "—"
                  )
                }
              />
              <TemplateItem
                label="Storage"
                value={
                  isLoading ? (
                    <Skeleton className="!h-[20px] !w-[60px] dark:!bg-black-300" />
                  ) : instanceData ? (
                    `${instanceData.flavor.disk_gb} GB`
                  ) : (
                    "—"
                  )
                }
              />
            </div>
          </div>
        </InfoPanel>

        <InfoPanel
          label="Created At"
          icon={<Icons.CalendarRange className="size-[18px]" />}
          bodyClassName="h-[44px] py-0 flex items-center"
        >
          {isLoading ? (
            <Skeleton className="!h-[20px] !w-[180px] dark:!bg-black-300" />
          ) : instanceData ? (
            <span className="text-[14px] font-medium leading-[22px] tracking-[-0.28px] text-black-700 dark:text-grey-light-300">
              {new Date(instanceData.created_at).toLocaleString()}
            </span>
          ) : null}
        </InfoPanel>
      </div>

      <StartStopConfirmModal />
    </div>
  );
};

export default VirtualMachineInfo;

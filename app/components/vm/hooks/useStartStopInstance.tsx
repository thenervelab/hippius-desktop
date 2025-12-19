import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Instance } from "../instances-table";
import ConfirmDialog2 from "../../ui/ConfirmDialog2";
import { Icons } from "../../ui";
import useStartVM from "@/app/lib/hooks/api/useStartVM";
import useStopVM from "@/app/lib/hooks/api/useStopVM";

interface UseStartStopInstanceOptions {
  onSuccess?: () => void;
}

export const useStartStopInstance = (options?: UseStartStopInstanceOptions) => {
  const { onSuccess } = options || {};
  const queryClient = useQueryClient();

  const [openConfirmModal, setOpenConfirmModal] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(
    null
  );
  const [action, setAction] = useState<"start" | "stop">("stop");

  // Use start and stop VM mutations
  const { mutateAsync: startVM, isPending: isStarting } = useStartVM({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vmInstances"] });
      queryClient.invalidateQueries({ queryKey: ["vm-instance-details"] });
    },
  });

  const { mutateAsync: stopVM, isPending: isStopping } = useStopVM({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vmInstances"] });
      queryClient.invalidateQueries({ queryKey: ["vm-instance-details"] });
    },
  });

  const handleStartStopInstance = (
    instance?: Instance,
    currentStatus?: string
  ) => {
    if (instance) {
      setSelectedInstance(instance);
    }
    // Determine action based on current status (case-insensitive)
    const actionType = currentStatus?.toLowerCase() === "stopped" ? "start" : "stop";
    setAction(actionType);
    setOpenConfirmModal(true);
  };

  const handleConfirm = async () => {
    if (!selectedInstance) return;

    try {
      if (action === "start") {
        await startVM(selectedInstance.id);
      } else {
        await stopVM(selectedInstance.id);
      }

      const actionText = action === "start" ? "Started" : "Stopped";
      toast.success(`Instance ${actionText} Successfully`);
      setOpenConfirmModal(false);
      setSelectedInstance(null);

      // Call custom success handler if provided
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Failed to ${action} instance`
      );
      console.error(`${action} instance error:`, error);
    }
  };

  const handleCancel = () => {
    if (isProcessing) return;
    setOpenConfirmModal(false);
    setSelectedInstance(null);
  };

  const isProcessing = isStarting || isStopping;

  const StartStopConfirmModal = () => (
    <ConfirmDialog2
      open={openConfirmModal}
      onClose={isProcessing ? () => {} : handleCancel}
      onConfirm={handleConfirm}
      onBack={isProcessing ? () => {} : handleCancel}
      button={
        isProcessing
          ? action === "start"
            ? "Starting..."
            : "Stopping..."
          : action === "start"
          ? "Start Instance"
          : "Stop Instance"
      }
      text={`Are you sure you want to ${action} this instance?`}
      heading={action === "start" ? "Start Instance" : "Stop Instance"}
      icon={
        action === "start" ? (
          <Icons.PlayCircle className="size-6 text-grey-100" />
        ) : (
          <Icons.StopCircle className="size-6 text-grey-100" />
        )
      }
      iconBgColor="bg-primary-50"
      disableButton={isProcessing}
    />
  );

  return {
    handleStartStopInstance,
    StartStopConfirmModal,
  };
};

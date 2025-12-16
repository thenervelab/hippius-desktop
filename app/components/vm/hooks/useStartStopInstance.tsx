import { useState } from "react";
import { toast } from "sonner";
import { Instance } from "../instances-table";
import ConfirmDialog2 from "../../ui/ConfirmDialog2";
import { Icons } from "../../ui";

interface UseStartStopInstanceOptions {
  onSuccess?: () => void;
}

export const useStartStopInstance = (options?: UseStartStopInstanceOptions) => {
  const { onSuccess } = options || {};

  const [openConfirmModal, setOpenConfirmModal] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(
    null
  );
  const [action, setAction] = useState<"start" | "stop">("stop");

  const handleStartStopInstance = (
    instance?: Instance,
    currentStatus?: string
  ) => {
    if (instance) {
      setSelectedInstance(instance);
    }
    // Determine action based on current status
    const actionType = currentStatus === "Stopped" ? "start" : "stop";
    setAction(actionType);
    setOpenConfirmModal(true);
  };

  const handleConfirm = async () => {
    try {
      // TODO: Replace with actual API call
      // await startStopInstanceAPI(selectedInstance?.id, action);

      const actionText = action === "start" ? "Started" : "Stopped";
      toast.success(`Instance ${actionText} Successfully`);
      setOpenConfirmModal(false);
      setSelectedInstance(null);

      // Call custom success handler if provided
      onSuccess?.();
    } catch (error) {
      toast.error(`Failed to ${action} instance`);
      console.error(`${action} instance error:`, error);
    }
  };

  const handleCancel = () => {
    setOpenConfirmModal(false);
    setSelectedInstance(null);
  };

  const StartStopConfirmModal = () => (
    <ConfirmDialog2
      open={openConfirmModal}
      onClose={handleCancel}
      onConfirm={handleConfirm}
      onBack={handleCancel}
      button={action === "start" ? "Start Instance" : "Stop Instance"}
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
    />
  );

  return {
    handleStartStopInstance,
    StartStopConfirmModal,
  };
};

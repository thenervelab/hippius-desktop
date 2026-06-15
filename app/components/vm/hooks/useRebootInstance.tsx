import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Instance } from "../instances-table";
import ConfirmationDialog from "../../ConfirmationDialog";
import { Icons } from "../../ui";
import useRebootVM from "@/app/lib/hooks/api/useRebootVM";

interface UseRebootInstanceOptions {
  onSuccess?: () => void;
}

export const useRebootInstance = (options?: UseRebootInstanceOptions) => {
  const { onSuccess } = options || {};
  const queryClient = useQueryClient();

  const [openConfirmModal, setOpenConfirmModal] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(
    null,
  );

  // Use reboot VM mutation
  const { mutateAsync: rebootVM, isPending: isRebooting } = useRebootVM({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vmInstances"] });
      queryClient.invalidateQueries({ queryKey: ["vm-instance-details"] });
    },
  });

  const handleRebootInstance = (instance?: Instance) => {
    if (instance) {
      setSelectedInstance(instance);
    }
    setOpenConfirmModal(true);
  };

  const handleConfirm = async () => {
    if (!selectedInstance) return;

    try {
      await rebootVM(selectedInstance.id);

      toast.success("Instance Rebooted Successfully");
      setOpenConfirmModal(false);
      setSelectedInstance(null);

      // Call custom success handler if provided
      onSuccess?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to reboot instance",
      );
      console.error("Reboot instance error:", error);
    }
  };

  const handleCancel = () => {
    if (isRebooting) return;
    setOpenConfirmModal(false);
    setSelectedInstance(null);
  };

  const RebootConfirmModal = () => (
    <ConfirmationDialog
      open={openConfirmModal}
      onClose={isRebooting ? () => {} : handleCancel}
      onBack={isRebooting ? () => {} : handleCancel}
      onConfirm={handleConfirm}
      button={isRebooting ? "Rebooting..." : "Reboot Instance"}
      text="Are you sure you want to reboot this instance? This will restart the instance and may cause temporary downtime."
      heading="Reboot Instance"
      icon={<Icons.Refresh2 className="size-6 text-grey-100" />}
      iconBgColor="bg-primary-50"
      disableButton={isRebooting}
      disableBackButton={isRebooting}
    />
  );

  return {
    handleRebootInstance,
    RebootConfirmModal,
  };
};

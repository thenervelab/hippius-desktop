import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import ConfirmDialog2 from "../../ui/ConfirmDialog2";
import { Icons } from "../../ui";
import { Instance } from "../instances-table";
import useRebootVM from "@/app/lib/hooks/api/useRebootVM";

interface UseRebootInstanceOptions {
  onSuccess?: () => void;
}

export const useRebootInstance = (options?: UseRebootInstanceOptions) => {
  const { onSuccess } = options || {};
  const queryClient = useQueryClient();

  const [openConfirmModal, setOpenConfirmModal] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(
    null
  );

  // Use reboot VM mutation
  const { mutateAsync: rebootVM, isPending: isRebooting } = useRebootVM({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vm-instances"] });
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
        error instanceof Error ? error.message : "Failed to reboot instance"
      );
      console.error("Reboot instance error:", error);
    }
  };

  const handleCancel = () => {
    setOpenConfirmModal(false);
    setSelectedInstance(null);
  };

  const RebootConfirmModal = () => (
    <ConfirmDialog2
      open={openConfirmModal}
      onClose={handleCancel}
      onConfirm={handleConfirm}
      onBack={handleCancel}
      button={isRebooting ? "Rebooting..." : "Reboot Instance"}
      text="Are you sure you want to reboot this instance? This will restart the instance and may cause temporary downtime."
      heading="Reboot Instance"
      icon={<Icons.Refresh2 className="size-6 text-grey-100" />}
      iconBgColor="bg-primary-50"
      disableButton={isRebooting}
    />
  );

  return {
    handleRebootInstance,
    RebootConfirmModal,
  };
};

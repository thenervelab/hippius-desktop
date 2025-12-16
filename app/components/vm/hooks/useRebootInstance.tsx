import { useState } from "react";
import { toast } from "sonner";
import ConfirmDialog2 from "../../ui/ConfirmDialog2";
import { Icons } from "../../ui";
import { Instance } from "../instances-table";

interface UseRebootInstanceOptions {
  onSuccess?: () => void;
}

export const useRebootInstance = (options?: UseRebootInstanceOptions) => {
  const { onSuccess } = options || {};

  const [openConfirmModal, setOpenConfirmModal] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(
    null
  );

  const handleRebootInstance = (instance?: Instance) => {
    if (instance) {
      setSelectedInstance(instance);
    }
    setOpenConfirmModal(true);
  };

  const handleConfirm = async () => {
    try {
      // TODO: Replace with actual API call
      // await rebootInstanceAPI(selectedInstance?.id);

      toast.success("Instance Rebooted Successfully");
      setOpenConfirmModal(false);
      setSelectedInstance(null);

      // Call custom success handler if provided
      onSuccess?.();
    } catch (error) {
      toast.error("Failed to reboot instance");
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
      button="Reboot Instance"
      text="Are you sure you want to reboot this instance? This will restart the instance and may cause temporary downtime."
      heading="Reboot Instance"
      icon={<Icons.Refresh2 className="size-6 text-grey-100" />}
      iconBgColor="bg-primary-50"
    />
  );

  return {
    handleRebootInstance,
    RebootConfirmModal,
  };
};

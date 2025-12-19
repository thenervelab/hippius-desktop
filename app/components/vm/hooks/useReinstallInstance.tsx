import { useState } from "react";
import { toast } from "sonner";
import ConfirmDialog2 from "../../ui/ConfirmDialog2";
import { Icons } from "../../ui";
import { Instance } from "../instances-table";

interface UseReinstallInstanceOptions {
  onSuccess?: () => void;
}

export const useReinstallInstance = (options?: UseReinstallInstanceOptions) => {
  const { onSuccess } = options || {};

  const [openConfirmModal, setOpenConfirmModal] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleReinstallInstance = (instance?: Instance) => {
    if (instance) {
      console.log("Preparing to reinstall instance:", instance);
    }
    setOpenConfirmModal(true);
  };

  const handleConfirm = async () => {
    setIsProcessing(true);
    try {
      // TODO: Replace with actual API call
      // await reinstallInstanceAPI(selectedInstance?.id);

      toast.success("Instance Reinstalled Successfully");
      setOpenConfirmModal(false);

      // Call custom success handler if provided
      onSuccess?.();
    } catch (error) {
      toast.error("Failed to reinstall instance");
      console.error("Reinstall instance error:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    if (isProcessing) return;
    setOpenConfirmModal(false);
  };

  const ReinstallConfirmModal = () => (
    <ConfirmDialog2
      open={openConfirmModal}
      onClose={isProcessing ? () => {} : handleCancel}
      onConfirm={handleConfirm}
      onBack={isProcessing ? () => {} : handleCancel}
      button={isProcessing ? "Reinstalling..." : "Reinstall Instance"}
      disableButton={isProcessing}
      text="Are you sure you want to reinstall this instance? This will erase all data and reset the instance to its initial state. This action cannot be undone."
      heading="Reinstall Instance"
      icon={<Icons.Refresh className="size-6 text-grey-100" />}
      iconBgColor="bg-warning-50"
    />
  );

  return {
    handleReinstallInstance,
    ReinstallConfirmModal,
  };
};

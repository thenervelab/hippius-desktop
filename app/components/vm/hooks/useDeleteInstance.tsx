import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Instance } from "../instances-table";
import ConfirmationDialog from "../../ConfirmationDialog";
import useTerminateVM from "@/app/lib/hooks/api/useTerminateVM";

interface UseDeleteInstanceOptions {
  redirectOnDelete?: boolean;
  redirectPath?: string;
  onDeleteSuccess?: () => void;
}

export const useDeleteInstance = (options?: UseDeleteInstanceOptions) => {
  const {
    redirectOnDelete = false,
    redirectPath = "vm",
    onDeleteSuccess,
  } = options || {};

  const router = useRouter();
  const queryClient = useQueryClient();
  const [openDeleteModal, setOpenDeleteModal] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(
    null,
  );

  // Use the terminate VM mutation
  const { mutateAsync: terminateVM, isPending: isDeleting } = useTerminateVM({
    onSuccess: () => {
      // Invalidate and refetch VM instances list and details
      queryClient.invalidateQueries({ queryKey: ["vmInstances"] });
      queryClient.invalidateQueries({ queryKey: ["vm-instance-details"] });
    },
  });

  const handleDeleteInstance = (instance?: Instance) => {
    if (instance) {
      setSelectedInstance(instance);
    }
    setOpenDeleteModal(true);
  };

  const handleConfirmDelete = async () => {
    if (!selectedInstance) return;

    try {
      await terminateVM(selectedInstance.id);

      toast.success("Virtual Machine Deleted Successfully");
      setOpenDeleteModal(false);
      setSelectedInstance(null);

      // Call custom success handler if provided
      onDeleteSuccess?.();

      // Redirect if specified
      if (redirectOnDelete) {
        router.push(redirectPath);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete instance",
      );
      console.error("Delete instance error:", error);
    }
  };

  const handleCancelDelete = () => {
    if (isDeleting) return;
    setOpenDeleteModal(false);
    setSelectedInstance(null);
  };

  const DeleteInstanceModal = () => (
    <ConfirmationDialog
      open={openDeleteModal}
      onClose={isDeleting ? () => {} : handleCancelDelete}
      onBack={isDeleting ? () => {} : handleCancelDelete}
      onConfirm={handleConfirmDelete}
      button={isDeleting ? "Deleting..." : "Delete Instance"}
      text="Are you sure you want to delete this instance? This action is permanent and all data will be lost."
      heading="Delete Instance"
      icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
      iconBgColor="bg-[#fc7d73]"
      confirmVariant="destructive"
      disableButton={isDeleting}
      disableBackButton={isDeleting}
    />
  );

  return {
    handleDeleteInstance,
    DeleteInstanceModal,
  };
};

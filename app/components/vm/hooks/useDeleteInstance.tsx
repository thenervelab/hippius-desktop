import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Instance } from "../instances-table";
import DeleteConfirmationDialog from "../../DeleteConfirmationDialog";
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
    null
  );

  // Use the terminate VM mutation
  const { mutateAsync: terminateVM, isPending: isDeleting } = useTerminateVM({
    onSuccess: () => {
      // Invalidate and refetch VM instances
      queryClient.invalidateQueries({ queryKey: ["vm-instances"] });
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
        error instanceof Error ? error.message : "Failed to delete instance"
      );
      console.error("Delete instance error:", error);
    }
  };

  const handleCancelDelete = () => {
    setOpenDeleteModal(false);
    setSelectedInstance(null);
  };

  const DeleteInstanceModal = () => (
    <DeleteConfirmationDialog
      open={openDeleteModal}
      onClose={handleCancelDelete}
      onBack={handleCancelDelete}
      onDelete={handleConfirmDelete}
      button={isDeleting ? "Deleting..." : "Delete Instance"}
      text="Are you sure you want to delete this instance? This action is permanent and all data will be lost."
      heading="Delete Instance"
      disableButton={isDeleting}
    />
  );

  return {
    handleDeleteInstance,
    DeleteInstanceModal,
  };
};

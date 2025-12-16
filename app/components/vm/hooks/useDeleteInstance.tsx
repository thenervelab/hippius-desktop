import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Instance } from "../instances-table";
import DeleteConfirmationDialog from "../../DeleteConfirmationDialog";

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
  const [openDeleteModal, setOpenDeleteModal] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<Instance | null>(
    null
  );

  const handleDeleteInstance = (instance?: Instance) => {
    if (instance) {
      setSelectedInstance(instance);
    }
    setOpenDeleteModal(true);
  };

  const handleConfirmDelete = async () => {
    try {
      // TODO: Replace with actual API call
      // await deleteInstanceAPI(selectedInstance?.id);

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
      toast.error("Failed to delete instance");
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
      button="Delete Instance"
      text="Are you sure you want to delete this instance? This action is permanent and all data will be lost."
      heading="Delete Instance"
    />
  );

  return {
    handleDeleteInstance,
    DeleteInstanceModal,
  };
};

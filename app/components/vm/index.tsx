"use client";

import AbstractIconWrapper from "../ui/abstract-icon-wrapper";
import { FC, useEffect, useState } from "react";

import { toast } from "sonner";
import RefreshButton from "../ui/refresh-button";
import { useRouter } from "next/navigation";
import InstancesTable from "./instances-table";
import SSHKeysTable, { SSHKey } from "./ssh-keys-table";
import CreateSSHKeyModal, {
  CreateSSHKeyData,
} from "./ssh-keys-table/create-ssh-key-modal";
import { MOCK_VM_TEMPLATES } from "./create-vm/mock-templates";
import VMTemplateCard from "./create-vm/vm-template-card";
import * as TableModule from "@/components/ui/alt-table";
import { useDeleteInstance } from "./hooks/useDeleteInstance";
import { Icons, SearchInput } from "../ui";
import TabList, { TabOption } from "../ui/tabs/TabList";
import { usePagination } from "@/app/lib/hooks";
import DeleteConfirmationDialog from "../DeleteConfirmationDialog";
import CreateButton from "../ui/button/CreateButton";
import useDeleteSSHKey from "@/app/lib/hooks/api/useDeleteSSHKey";
import useCreateSSHKey from "@/app/lib/hooks/api/useCreateSSHKey";

export interface CreateTokenFields {
  name: string;
  scopes: string[];
}

const VirtualMachines: FC = () => {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<string>("Instances");
  const [openCreateSSHKeyModal, setOpenCreateSSHKeyModal] = useState(false);
  const [openDeleteSSHKeyModal, setOpenDeleteSSHKeyModal] = useState(false);
  const [openDeleteTemplateModal, setOpenDeleteTemplateModal] = useState(false);
  const [sshKeySearchTerm, setSSHKeySearchTerm] = useState("");
  const [debouncedSSHKeySearchTerm, setDebouncedSSHKeySearchTerm] =
    useState("");
  const [sshKeyRefreshTrigger, setSSHKeyRefreshTrigger] = useState(0);
  const [isSSHKeyRefetching, setIsSSHKeyRefetching] = useState(false);
  const [selectedSSHKeyToDelete, setSelectedSSHKeyToDelete] =
    useState<SSHKey | null>(null);
  const [isDeletingInProgress, setIsDeletingInProgress] = useState(false);

  // Debounce SSH key search term with 500ms delay
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSSHKeySearchTerm(sshKeySearchTerm);
    }, 500);

    return () => clearTimeout(timer);
  }, [sshKeySearchTerm]);

  // Use delete instance hook
  const { handleDeleteInstance, DeleteInstanceModal } = useDeleteInstance();

  // Use create SSH key mutation
  const { mutateAsync: createSSHKey, isPending: isCreatingSSHKey } =
    useCreateSSHKey();

  // Use delete SSH key mutation
  const { mutate: deleteSSHKey } = useDeleteSSHKey({
    onSuccess: () => {
      toast.success("SSH Key deleted successfully!");
      setOpenDeleteSSHKeyModal(false);
      setSelectedSSHKeyToDelete(null);
      setIsDeletingInProgress(false);
      // Trigger refresh of SSH keys table
      setSSHKeyRefreshTrigger((prev) => prev + 1);
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete SSH key");
      setIsDeletingInProgress(false);
    },
  });

  const {
    paginatedData: templates,
    setCurrentPage: setTemplatesPage,
    currentPage: templatesCurrentPage,
    totalPages: templatesTotalPages,
  } = usePagination(MOCK_VM_TEMPLATES, 8);

  const tabs: TabOption[] = [
    {
      tabName: "Instances",
      icon: <Icons.DriverRefresh />,
    },
    {
      tabName: "Templates",
      icon: <Icons.Note />,
    },
    {
      tabName: "SSH Keys",
      icon: <Icons.Key />,
    },
  ];

  const handleTabChange = (tabName: string) => {
    setActiveTab(tabName);
  };

  const handleModalOpen = () => {
    if (activeTab === "SSH Keys") {
      setOpenCreateSSHKeyModal(true);
    } else if (activeTab === "Instances") {
      router.push("/dashboard/vm/create");
    }
  };

  const handleCreateSSHKey = async (data: CreateSSHKeyData) => {
    try {
      await createSSHKey({
        name: data.keyName,
        public_key: data.publicKey,
      });
      toast.success("SSH Key created successfully!");
      setOpenCreateSSHKeyModal(false);
      // Trigger refresh of SSH keys table
      setSSHKeyRefreshTrigger((prev) => prev + 1);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create SSH key"
      );
      throw error; // Re-throw so modal knows it failed
    }
  };

  const handleDeleteSSHKey = (sshKey: SSHKey) => {
    setSelectedSSHKeyToDelete(sshKey);
    setOpenDeleteSSHKeyModal(true);
  };

  const handleConfirmDeleteSSHKey = () => {
    if (selectedSSHKeyToDelete && !isDeletingInProgress) {
      setIsDeletingInProgress(true);
      deleteSSHKey(selectedSSHKeyToDelete.id);
    }
  };

  const handleDeleteTemplate = () => {
    setOpenDeleteTemplateModal(true);
  };

  const handleConfirmDeleteTemplate = () => {
    setOpenDeleteTemplateModal(false);
    toast.success("Template Deleted");
  };

  const getHeaderTitle = () => {
    switch (activeTab) {
      case "SSH Keys":
        return "Your SSH Keys";
      case "Templates":
        return "Your Templates";
      default:
        return "Your Machines";
    }
  };

  return (
    <div className="w-full">
      <div className="flex items-center w-full justify-between gap-4 flex-wrap mb-4">
        <div className="flex flex-col max-sm:w-full sm:flex-row gap-4 items-center">
          <div className="flex items-center jusityfy-between w-full sm:w-auto">
            <div className="flex flex-nowrap items-center gap-x-2">
              <AbstractIconWrapper className="size-10 flex items-center justify-center">
                {activeTab === "SSH Keys" ? (
                  <Icons.Key className="size-6 relative text-primary-50" />
                ) : (
                  <Icons.Driver2 className="size-6 relative text-primary-50" />
                )}
              </AbstractIconWrapper>
              <p className="font-medium text-base md:text-lg lg:text-xl text-nowrap">
                {getHeaderTitle()}
              </p>
            </div>
          </div>
          {/* Tab navigation */}
          <div className="border border-grey-80 rounded p-1 bg-grey-100">
            <TabList
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={handleTabChange}
              className="w-full "
              gap="gap-1"
              width="w-full sm:min-w-[148px]"
            />
          </div>
        </div>
        <div className="flex items-center gap-x-4">
          {activeTab === "Instances" && (
            <>
              <SearchInput
                placeholder="Search for an instance"
                className="h-9"
              />
              <RefreshButton refetching={false} onClick={() => {}} />
              <CreateButton
                text="Create VM"
                isLoading={false}
                onClick={handleModalOpen}
              />
            </>
          )}
          {activeTab === "SSH Keys" && (
            <>
              <SearchInput
                placeholder="Search for a key"
                className="h-9"
                value={sshKeySearchTerm}
                onChange={(value) => setSSHKeySearchTerm(value)}
              />
              <RefreshButton
                refetching={isSSHKeyRefetching}
                onClick={() => setSSHKeyRefreshTrigger((prev) => prev + 1)}
              />
              <CreateButton
                text="New SSH Key"
                isLoading={false}
                onClick={handleModalOpen}
              />
            </>
          )}
          {activeTab === "Templates" && (
            <>
              <SearchInput
                placeholder="Search for a template"
                className="h-9"
              />
              <RefreshButton refetching={false} onClick={() => {}} />
              <CreateButton
                text="New Template"
                isLoading={false}
                onClick={handleModalOpen}
              />
            </>
          )}
        </div>
      </div>

      {/* Display content based on activeTab */}
      <div className="mt-6">
        <div className="animate-in fade-in duration-300">
          {activeTab === "Instances" ? (
            <InstancesTable onDeleteInstance={handleDeleteInstance} />
          ) : activeTab === "SSH Keys" ? (
            <SSHKeysTable
              onDeleteKey={handleDeleteSSHKey}
              searchTerm={debouncedSSHKeySearchTerm}
              refreshTrigger={sshKeyRefreshTrigger}
              onRefetchingChange={setIsSSHKeyRefetching}
              onCreateNew={handleModalOpen}
            />
          ) : activeTab === "Templates" ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
                {templates.map((template) => (
                  <VMTemplateCard
                    key={template.id}
                    template={template}
                    onDelete={handleDeleteTemplate}
                    showSetupButton={false}
                  />
                ))}
              </div>
              {templatesTotalPages > 1 && (
                <TableModule.Pagination
                  currentPage={templatesCurrentPage}
                  totalPages={templatesTotalPages}
                  setPage={setTemplatesPage}
                />
              )}
            </>
          ) : (
            <div className="p-6 text-center text-grey-50">
              {activeTab} content will appear here
            </div>
          )}
        </div>
      </div>
      {/* Delete Instance Confirmation */}
      <DeleteInstanceModal />
      {/* Create SSH Key Modal */}
      <CreateSSHKeyModal
        open={openCreateSSHKeyModal}
        onClose={() => setOpenCreateSSHKeyModal(false)}
        onSubmit={handleCreateSSHKey}
        isLoading={isCreatingSSHKey}
      />
      {/* Delete SSH Key Confirmation */}
      <DeleteConfirmationDialog
        open={openDeleteSSHKeyModal}
        onClose={() => {
          if (!isDeletingInProgress) {
            setOpenDeleteSSHKeyModal(false);
            setSelectedSSHKeyToDelete(null);
          }
        }}
        onBack={() => {
          if (!isDeletingInProgress) {
            setOpenDeleteSSHKeyModal(false);
            setSelectedSSHKeyToDelete(null);
          }
        }}
        onDelete={handleConfirmDeleteSSHKey}
        button={isDeletingInProgress ? "Deleting..." : "Delete SSH Key"}
        text={`Are you sure you want to delete SSH key "${
          selectedSSHKeyToDelete?.name || "this key"
        }"? This action is permanent.`}
        heading="Delete SSH Key"
        disableButton={isDeletingInProgress}
      />
      {/* Delete Template Confirmation */}
      <DeleteConfirmationDialog
        open={openDeleteTemplateModal}
        onClose={() => {
          setOpenDeleteTemplateModal(false);
        }}
        onBack={() => {
          setOpenDeleteTemplateModal(false);
        }}
        onDelete={handleConfirmDeleteTemplate}
        button="Delete Template"
        text="Are you sure you want to delete this template? This action is permanent."
        heading="Delete Template"
      />
    </div>
  );
};

export default VirtualMachines;

"use client";

import AbstractIconWrapper from "../ui/abstract-icon-wrapper";
import { FC, useEffect, useState } from "react";
import React from "react";

import { toast } from "sonner";
import RefreshButton from "../ui/refresh-button";
import { useRouter } from "next/navigation";
import InstancesTable from "./instances-table";
import SSHKeysTable, { SSHKey } from "./ssh-keys-table";
import CreateSSHKeyModal, {
  CreateSSHKeyData,
} from "./ssh-keys-table/create-ssh-key-modal";
import VMTemplateCard from "./create-vm/vm-template-card";
import VMTemplateCardSkeleton from "./create-vm/vm-template-card-skeleton";
import * as TableModule from "@/components/ui/alt-table";
import { useDeleteInstance } from "./hooks/useDeleteInstance";
import { Icons, SearchInput } from "../ui";
import TabList, { TabOption } from "../ui/tabs/TabList";
import { usePagination } from "@/app/lib/hooks";
import DeleteConfirmationDialog from "../DeleteConfirmationDialog";
import CreateButton from "../ui/button/CreateButton";
import useDeleteSSHKey from "@/app/lib/hooks/api/useDeleteSSHKey";
import useCreateSSHKey from "@/app/lib/hooks/api/useCreateSSHKey";
import useVMFlavors from "@/app/lib/hooks/api/useVMFlavors";
import NoEntriesFound from "../ui/NoEntriesFound";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
const VM_DOCS_URL = "https://docs.hippius.com/use/virtual-machines";
const VM_SSH_DOCS_URL =
  "https://docs.hippius.com/use/virtual-machines#ssh-keys";
export interface CreateTokenFields {
  name: string;
  scopes: string[];
}

const VirtualMachines: FC = () => {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<string>("Instances");
  const [openCreateSSHKeyModal, setOpenCreateSSHKeyModal] = useState(false);
  const [openDeleteSSHKeyModal, setOpenDeleteSSHKeyModal] = useState(false);
  const [instanceSearchTerm, setInstanceSearchTerm] = useState("");
  const [debouncedInstanceSearchTerm, setDebouncedInstanceSearchTerm] =
    useState("");
  const [sshKeySearchTerm, setSSHKeySearchTerm] = useState("");
  const [debouncedSSHKeySearchTerm, setDebouncedSSHKeySearchTerm] =
    useState("");
  const [sshKeyRefreshTrigger, setSSHKeyRefreshTrigger] = useState(0);
  const [isSSHKeyRefetching, setIsSSHKeyRefetching] = useState(false);
  const [selectedSSHKeyToDelete, setSelectedSSHKeyToDelete] =
    useState<SSHKey | null>(null);
  const [isDeletingInProgress, setIsDeletingInProgress] = useState(false);
  const [instancesError, setInstancesError] = useState<Error | null>(null);
  const refetchInstancesRef = React.useRef<() => void>(() => {});
  const [isInstancesFetching, setIsInstancesFetching] = useState(false);

  const handleRefetchInstances = () => {
    refetchInstancesRef.current();
  };

  const setRefetchInstances = (fn: () => void) => {
    refetchInstancesRef.current = fn;
  };
  const {
    data: flavors,
    isLoading: isFlavorsLoading,
    error: flavorsError,
  } = useVMFlavors();
  const flavorsLoading = isFlavorsLoading;

  // Check if error is related to beta access
  const isBetaError = (error: Error | null) => {
    return error?.message?.toLowerCase().includes("beta") || false;
  };

  const betaAccessMessage =
    "VM feature is in beta. Contact support for access.";

  // Transform flavors API data to template format with categories
  const templatesFromFlavors =
    flavors?.map((flavor) => {
      const flavorName = flavor.name.toLowerCase();
      let category = "all";

      // Categorize based on flavor name
      if (flavorName === "spark" || flavorName === "pulse") {
        category = "starter";
      } else if (flavorName === "cipher" || flavorName === "vault") {
        category = "standard";
      } else if (
        flavorName === "fortress" ||
        flavorName === "titan" ||
        flavorName === "sovereign"
      ) {
        category = "high-capacity";
      }

      return {
        id: String(flavor.id),
        name: flavor.display_name,
        ram: "RAM",
        ramValue: `${(flavor.memory_mb / 1024).toFixed(0)} GB`,
        cores: "Cores",
        coresValue: `${flavor.cpu_cores} vCore${
          flavor.cpu_cores > 1 ? "s" : ""
        }`,
        storage: `${flavor.data_disk_gb} GB Storage`,
        bandwidth: "",
        price: `${flavor.credits_per_hour} credit${
          flavor.credits_per_hour !== 1 ? "s" : ""
        }/hour`,
        category,
      };
    }) || [];

  // Debounce instance search term with 500ms delay
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedInstanceSearchTerm(instanceSearchTerm);
    }, 500);

    return () => clearTimeout(timer);
  }, [instanceSearchTerm]);

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
  } = usePagination(templatesFromFlavors, 8);

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
      router.push("/vm/create");
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
        <div className="flex flex-col w-full @sm:w-auto @sm:flex-row gap-4 items-center">
          <div className="flex items-center jusityfy-between w-full @sm:w-auto">
            <div className="flex flex-nowrap items-center gap-x-2">
              <AbstractIconWrapper className="size-10 flex items-center justify-center">
                {activeTab === "SSH Keys" ? (
                  <Icons.Key className="size-6 relative text-primary-50" />
                ) : (
                  <Icons.Driver2 className="size-6 relative text-primary-50" />
                )}
              </AbstractIconWrapper>
              <p className="font-medium text-base @md:text-lg @xl:text-xl">
                {getHeaderTitle()}
              </p>
              <button
                onClick={() =>
                  openUrl(
                    activeTab === "SSH Keys" ? VM_SSH_DOCS_URL : VM_DOCS_URL
                  )
                }
                aria-label={
                  activeTab === "SSH Keys"
                    ? "SSH keys documentation"
                    : "Virtual machine documentation"
                }
                title={
                  activeTab === "SSH Keys"
                    ? "SSH keys documentation"
                    : "Virtual machine documentation"
                }
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50"
              >
                <HelpCircle className="size-4" />
              </button>
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
              width="w-full @sm:min-w-[9.25rem]"
            />
          </div>
        </div>
        <div className="flex items-center gap-x-4">
          {activeTab === "Instances" && (
            <>
              <SearchInput
                placeholder="Search for an instance"
                className="h-9"
                value={instanceSearchTerm}
                onChange={(value) => setInstanceSearchTerm(value)}
              />
              <RefreshButton
                refetching={isInstancesFetching}
                onClick={handleRefetchInstances}
              />
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
        </div>
      </div>

      {/* Display content based on activeTab */}
      <div className="mt-6">
        <div className="animate-in fade-in duration-300">
          {activeTab === "Instances" ? (
            isBetaError(instancesError) ? (
              <NoEntriesFound className="h-[31.25rem]">
                <div className="text-center">
                  <p className="text-grey-30 font-semibold mb-1 text-base">
                    Feature Not Available
                  </p>
                  <p className="text-grey-50 text-sm max-w-md">
                    {betaAccessMessage}
                  </p>
                </div>
              </NoEntriesFound>
            ) : (
              <InstancesTable
                onDeleteInstance={handleDeleteInstance}
                onCreateNew={handleModalOpen}
                flavors={flavors}
                isFlavorsLoading={isFlavorsLoading}
                searchTerm={debouncedInstanceSearchTerm}
                onError={setInstancesError}
                onRefetchChange={setRefetchInstances}
                onFetchingChange={setIsInstancesFetching}
              />
            )
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
              {isBetaError(flavorsError) ? (
                <NoEntriesFound className="h-[31.25rem]">
                  <div className="text-center">
                    <p className="text-grey-30 font-semibold mb-1 text-base">
                      Feature Not Available
                    </p>
                    <p className="text-grey-50 text-sm max-w-md">
                      {betaAccessMessage}
                    </p>
                  </div>
                </NoEntriesFound>
              ) : flavorsLoading ? (
                <div className="grid grid-cols-1 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 gap-4 mb-8">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <VMTemplateCardSkeleton key={`skeleton-${index}`} />
                  ))}
                </div>
              ) : templates.length === 0 ? (
                <NoEntriesFound text="No templates available" />
              ) : (
                <>
                  <div className="grid grid-cols-1 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 gap-4 mb-8">
                    {templates.map((template) => (
                      <VMTemplateCard
                        key={template.id}
                        template={template}
                        showSetupButton={false}
                        hideMenu={true}
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
    </div>
  );
};

export default VirtualMachines;

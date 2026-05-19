"use client";

import { getFlavorCategory } from "@/lib/utils/vmUtils";
import { FC, useEffect, useState } from "react";
import React from "react";

import { toast } from "sonner";
import RefreshButton from "../ui/refresh-button";
import { useRouter } from "next/navigation";
import InstancesTable, { VMTablePaginationState } from "./instances-table";
import SSHKeysTable, { SSHKey } from "./ssh-keys-table";
import CreateSSHKeyModal, {
  CreateSSHKeyData,
} from "./ssh-keys-table/create-ssh-key-modal";
import VMTemplateCard from "./create-vm/vm-template-card";
import VMTemplateCardSkeleton from "./create-vm/vm-template-card-skeleton";
import * as TableModule from "@/components/ui/alt-table";
import { useDeleteInstance } from "./hooks/useDeleteInstance";
import { Icons, SearchInput } from "../ui";
import { InfoCircle } from "@/app/components/ui/icons";
import PageHeader from "@/components/ui/page-header";
import TabList, { TabOption } from "../ui/tabs/TabList";
import { usePagination } from "@/app/lib/hooks";
import DeleteConfirmationDialog from "../DeleteConfirmationDialog";
import CreateButton from "../ui/button/CreateButton";
import useDeleteSSHKey from "@/app/lib/hooks/api/useDeleteSSHKey";
import useCreateSSHKey from "@/app/lib/hooks/api/useCreateSSHKey";
import useVMFlavors from "@/app/lib/hooks/api/useVMFlavors";
import NoEntriesFound from "../ui/NoEntriesFound";
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
  const [instancesPagination, setInstancesPagination] =
    useState<VMTablePaginationState | null>(null);
  const [sshKeysPagination, setSSHKeysPagination] =
    useState<VMTablePaginationState | null>(null);
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
      const category = getFlavorCategory(flavor.name);

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
      icon: <Icons.DriverRefresh className="size-3.5" />,
    },
    {
      tabName: "Templates",
      icon: <Icons.Note className="size-3.5" />,
    },
    {
      tabName: "SSH Keys",
      icon: <Icons.Key className="size-3.5" />,
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
        error instanceof Error ? error.message : "Failed to create SSH key",
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

  const isInstancesTab = activeTab === "Instances";
  const isTemplatesTab = activeTab === "Templates";
  const isSSHKeysTab = activeTab === "SSH Keys";
  const showToolbarControls = isInstancesTab || isSSHKeysTab;

  const toolbarSearchTerm = isInstancesTab
    ? instanceSearchTerm
    : sshKeySearchTerm;
  const setToolbarSearchTerm = isInstancesTab
    ? setInstanceSearchTerm
    : setSSHKeySearchTerm;
  const toolbarSearchPlaceholder = isInstancesTab
    ? "Search for an instance"
    : "Search for a key";
  const isToolbarRefetching = isInstancesTab
    ? isInstancesFetching
    : isSSHKeyRefetching;
  const createButtonText = isInstancesTab ? "+ New VM" : "+ New SSH Key";

  const activePagination = isInstancesTab
    ? instancesPagination
    : isSSHKeysTab
      ? sshKeysPagination
      : null;

  const handleToolbarRefresh = () => {
    if (isInstancesTab) {
      handleRefetchInstances();
      return;
    }
    setSSHKeyRefreshTrigger((prev) => prev + 1);
  };

  const showMiniPagination =
    !!activePagination &&
    !activePagination.isError &&
    !activePagination.isLoading &&
    !activePagination.isRefetching &&
    activePagination.hasData &&
    activePagination.totalPages > 1;

  const miniPagination = showMiniPagination ? (
    <TableModule.MiniPaginationControl
      currentPage={activePagination.currentPage}
      totalPages={activePagination.totalPages}
      pageSize={activePagination.pageSize}
      totalCount={activePagination.totalCount}
      onPrev={() =>
        activePagination.setPage(Math.max(1, activePagination.currentPage - 1))
      }
      onNext={() =>
        activePagination.setPage(
          Math.min(
            activePagination.totalPages,
            activePagination.currentPage + 1,
          ),
        )
      }
    />
  ) : null;

  return (
    <div className="w-full">
      {/* Top section header — PageHeader (title + info button) on the left,
          contextual Create button on the right. Mirrors the Files page
          treatment so VM / SSH Keys / Templates share the same header
          language as the rest of the app. */}
      <div className="flex items-center w-full justify-between gap-4 flex-wrap p-3">
        <PageHeader
          hideStats
          title={getHeaderTitle()}
          infoTooltip={
            <button
              onClick={() =>
                openUrl(isSSHKeysTab ? VM_SSH_DOCS_URL : VM_DOCS_URL)
              }
              aria-label={
                isSSHKeysTab
                  ? "SSH keys documentation"
                  : "Virtual machine documentation"
              }
              title={
                isSSHKeysTab
                  ? "SSH keys documentation"
                  : "Virtual machine documentation"
              }
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-grey-dark-100 bg-grey-light-700 text-black transition-colors hover:bg-grey-90 hover:text-primary-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400 dark:hover:border-black-100 dark:hover:bg-black-300 dark:hover:text-primary-50"
            >
              <InfoCircle className="size-4" />
            </button>
          }
          className="!shadow-none !p-0 flex-1 min-w-0"
        />
        {!isTemplatesTab && (
          <CreateButton
            text={createButtonText}
            isLoading={false}
            onClick={handleModalOpen}
          />
        )}
      </div>

      {/* Tabs row — tab list on the left and search / refresh / mini
          pagination on the right. Matches the Figma toolbar pattern. */}
      <div className="flex items-center w-full justify-between gap-4 flex-wrap mb-4">
        <TabList
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          gap="gap-[3.831px]"
          width="w-auto"
          height="h-6"
          tabItemPaddingX="px-[6.13px]"
          textClassName="font-medium text-[12px] tracking-[-0.24px] leading-[1.109]"
          className="p-[3.065px]"
        />
        {showToolbarControls && (
          <div className="flex items-center gap-x-3 flex-wrap">
            <SearchInput
              placeholder={toolbarSearchPlaceholder}
              className="h-8 w-[207px]"
              value={toolbarSearchTerm}
              onChange={(value) => setToolbarSearchTerm(value)}
            />
            <RefreshButton
              refetching={isToolbarRefetching}
              onClick={handleToolbarRefresh}
            />
            {miniPagination}
          </div>
        )}
      </div>

      {/* Display content based on activeTab */}
      <div className="mt-6">
        <div className="animate-in fade-in duration-300">
          {isInstancesTab ? (
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
                onPaginationChange={setInstancesPagination}
              />
            )
          ) : isSSHKeysTab ? (
            <SSHKeysTable
              onDeleteKey={handleDeleteSSHKey}
              searchTerm={debouncedSSHKeySearchTerm}
              refreshTrigger={sshKeyRefreshTrigger}
              onRefetchingChange={setIsSSHKeyRefetching}
              onCreateNew={handleModalOpen}
              onPaginationChange={setSSHKeysPagination}
            />
          ) : isTemplatesTab ? (
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
                <NoEntriesFound title="No templates available" />
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

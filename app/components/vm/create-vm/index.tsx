"use client";

import React, { useState } from "react";
import { getFlavorCategory } from "@/lib/utils/vmUtils";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import VMTemplateCard, { VMTemplate } from "./vm-template-card";
import VMTemplateCardSkeleton from "./vm-template-card-skeleton";
import * as TableModule from "@/components/ui/alt-table";

import CreateVMModal, { VMConfigurationData } from "./create-vm-modal";
import TabList, { TabOption } from "../../ui/tabs/TabList";
import { usePagination } from "@/app/lib/hooks";
import CustomTooltip2 from "../../ui/CustomTooltip2";
import { Select } from "../../ui";
import useVMFlavors from "@/app/lib/hooks/api/useVMFlavors";
import NoEntriesFound from "../../ui/NoEntriesFound";
import { openUrl } from "@tauri-apps/plugin-opener";
const VM_DOCS_URL =
  "https://docs.hippius.com/use/virtual-machines#create-a-virtual-machine";

const CreateVM: React.FC = () => {
  const router = useRouter();
  const [activeCategory, setActiveCategory] = useState<string>("All Models");
  const [openCreateVMModal, setOpenCreateVMModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<VMTemplate | null>(
    null
  );
  const {
    data: flavors,
    isLoading: isFlavorsLoading,
    error: flavorsError,
  } = useVMFlavors();

  // Check if error is related to beta access
  const isBetaError =
    flavorsError?.message?.toLowerCase().includes("beta") || false;
  const betaAccessMessage =
    "VM feature is in beta. Contact support for access.";

  // Transform flavors API data to template format with categories
  const categorizedTemplates =
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

  const categories: TabOption[] = [
    { tabName: "All Models" },
    { tabName: "Starter" },
    { tabName: "Standard" },
    { tabName: "High Capacity" },
  ];

  const getCategoryKey = (tabName: string): string => {
    const categoryMap: Record<string, string> = {
      "All Models": "all",
      Starter: "starter",
      Standard: "standard",
      "High Capacity": "high-capacity",
    };
    return categoryMap[tabName] || "all";
  };

  const filteredTemplates =
    activeCategory === "All Models"
      ? categorizedTemplates
      : categorizedTemplates.filter(
          (template) => template.category === getCategoryKey(activeCategory)
        );

  const {
    paginatedData: templates,
    setCurrentPage,
    currentPage,
    totalPages,
  } = usePagination(filteredTemplates, 8);

  const handleTemplateSelect = (template: VMTemplate) => {
    setSelectedTemplate(template);
    setOpenCreateVMModal(true);
  };

  const handleVMSubmit = (data: VMConfigurationData) => {
    console.log("VM Configuration:", data, "Template:", selectedTemplate);
    setOpenCreateVMModal(false);
    // Handle VM creation API call here
    // Redirect to VM table page
    router.push("/vm");
  };

  const handleBack = () => {
    router.back();
  };

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-6">
        <div className="flex items-center gap-2 mb-6">
          <button
            onClick={handleBack}
            className="p-1 hover:bg-grey-90 rounded transition"
          >
            <ArrowLeft className="size-6 text-grey-10" />
          </button>
          <h1 className="text-[1.375rem] font-medium text-grey-10">
            Create New Virtual Machine
          </h1>
        </div>
        <button
          onClick={() => openUrl(VM_DOCS_URL)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-50 hover:text-primary-40 transition-colors"
        >
          Help me Create
          <ExternalLink className="size-4" />
        </button>
      </div>

      {/* Select a Model Section */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-[1.375rem] font-medium text-grey-10">
            Select a Model
          </h2>
          <CustomTooltip2
            showInfo={true}
            tooltipContent="Choose a VM model that fits your workload requirements. Different models are optimized for specific use cases like general purpose computing, memory-intensive tasks, or storage operations."
          />
        </div>
        <div className="flex @sm:hidden justify-between items-center p-1 border border-grey-80 rounded z-20">
          <div className="w-full text-lg font-medium text-grey-10">
            Currently Viewing
          </div>
          <Select
            options={categories.map((cat) => ({
              label: cat.tabName,
              value: cat.tabName,
            }))}
            value={activeCategory}
            onValueChange={setActiveCategory}
            placeholder="Select a tab"
            className="w-[12.5rem] h-[2.375rem] z-20"
            triggerClassName="w-full justify-between"
          />
        </div>
        {/* Category Tabs */}
        <div className="hidden @sm:block">
          <div className="border border-grey-80 rounded p-1 bg-grey-100">
            <TabList
              tabs={categories}
              activeTab={activeCategory}
              onTabChange={setActiveCategory}
              className="w-full"
              width="w-full"
            />
          </div>
        </div>
      </div>

      {/* Templates Grid */}
      {isBetaError ? (
        <NoEntriesFound className="h-[31.25rem]">
          <div className="text-center">
            <p className="text-grey-30 font-semibold mb-1 text-base">
              Feature Not Available
            </p>
            <p className="text-grey-50 text-sm max-w-md">{betaAccessMessage}</p>
          </div>
        </NoEntriesFound>
      ) : isFlavorsLoading ? (
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
                onSelect={handleTemplateSelect}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <TableModule.Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              setPage={setCurrentPage}
            />
          )}
        </>
      )}

      {/* Create VM Modal */}
      <CreateVMModal
        open={openCreateVMModal}
        onClose={() => setOpenCreateVMModal(false)}
        onSubmit={handleVMSubmit}
        template={selectedTemplate}
      />
    </div>
  );
};

export default CreateVM;

"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import VMTemplateCard, { VMTemplate } from "./vm-template-card";
import { MOCK_VM_TEMPLATES } from "./mock-templates";
import * as TableModule from "@/components/ui/alt-table";

import CreateVMModal, { VMConfigurationData } from "./create-vm-modal";
import TabList, { TabOption } from "../../ui/tabs/TabList";
import { usePagination } from "@/app/lib/hooks";
import CustomTooltip2 from "../../ui/CustomTooltip2";
import { Select } from "../../ui";

const CreateVM: React.FC = () => {
  const router = useRouter();
  const [activeCategory, setActiveCategory] = useState<string>("All Models");
  const [openCreateVMModal, setOpenCreateVMModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<VMTemplate | null>(
    null
  );

  const categories: TabOption[] = [
    { tabName: "All Models" },
    { tabName: "General Purpose" },
    { tabName: "Compute Optimized" },
    { tabName: "Memory Optimized" },
    { tabName: "Discovery" },
    { tabName: "Storage Optimized" },
  ];

  const getCategoryKey = (tabName: string): string => {
    const categoryMap: Record<string, string> = {
      "All Models": "all",
      "General Purpose": "general",
      "Compute Optimized": "compute",
      "Memory Optimized": "memory",
      Discovery: "discovery",
      "Storage Optimized": "storage",
    };
    return categoryMap[tabName] || "all";
  };

  const filteredTemplates =
    activeCategory === "All Models"
      ? MOCK_VM_TEMPLATES
      : MOCK_VM_TEMPLATES.filter(
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
    router.push("/dashboard/vm");
  };

  const handleBack = () => {
    router.back();
  };

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <button
          onClick={handleBack}
          className="p-1 hover:bg-grey-90 rounded transition"
        >
          <ArrowLeft className="size-6 text-grey-10" />
        </button>
        <h1 className="text-[22px] font-medium text-grey-10">
          Create New Virtual Machine
        </h1>
      </div>

      {/* Select a Model Section */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-[22px] font-medium text-grey-10">
            Select a Model
          </h2>
          <CustomTooltip2
            showInfo={true}
            tooltipContent="Choose a VM model that fits your workload requirements. Different models are optimized for specific use cases like general purpose computing, memory-intensive tasks, or storage operations."
          />
        </div>
        <div className="flex sm:hidden justify-between items-center p-1 border border-grey-80 rounded z-20">
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
            className="w-[200px] h-[38px] z-20"
            triggerClassName="w-full justify-between"
          />
        </div>
        {/* Category Tabs */}
        <div className="hidden sm:block">
          <TabList
            tabs={categories}
            activeTab={activeCategory}
            onTabChange={setActiveCategory}
            className="w-full"
            width="w-full"
          />
        </div>
      </div>

      {/* Templates Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
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

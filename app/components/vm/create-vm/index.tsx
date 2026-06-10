"use client";

import React, { useState } from "react";
import { getFlavorCategory } from "@/lib/utils/vmUtils";
import { useRouter } from "next/navigation";
import VMTemplateCard, { VMTemplate } from "./vm-template-card";
import VMTemplateCardSkeleton from "./vm-template-card-skeleton";
import * as TableModule from "@/components/ui/alt-table";

import CreateVMModal, { VMConfigurationData } from "./create-vm-modal";
import { usePagination } from "@/app/lib/hooks";
import CustomTooltip2 from "../../ui/CustomTooltip2";
import { Button, Icons } from "../../ui";
import { InfoCircle } from "@/app/components/ui/icons";
import useVMFlavors from "@/app/lib/hooks/api/useVMFlavors";
import NoEntriesFound from "../../ui/NoEntriesFound";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import Link from "next/link";
const VM_DOCS_URL =
  "https://docs.hippius.com/use/virtual-machines#create-a-virtual-machine";

const CreateVM: React.FC = () => {
  const router = useRouter();
  const [activeCategory, setActiveCategory] = useState<string>("All Models");
  const [openCreateVMModal, setOpenCreateVMModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<VMTemplate | null>(
    null,
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

  const categories = [
    "All Models",
    "Starter",
    "Standard",
    "High Capacity",
  ] as const;

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
          (template) => template.category === getCategoryKey(activeCategory),
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

  return (
    <div className="w-full">
      {/* Header — single row mirrors the console layout: back button +
          title + info tooltip on the left, "Help me create?" on the right.
          Intentionally omits the console's bottom border/shadow per design
          ask. */}
      <div className="flex items-center w-full justify-between gap-4 flex-wrap pb-3">
        <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
          <Link
            href="/vm"
            aria-label="Go back"
            className="text-black-600/50 hover:text-grey-40 dark:text-grey-light-100 dark:hover:text-grey-dark-400"
          >
            <Icons.ArrowLeft className="size-5" />
          </Link>
          <h1 className="text-[22px] @sm:text-[24px] font-medium leading-8 text-grey-10 dark:text-grey-light-100">
            Create New Virtual Machine
          </h1>
          <CustomTooltip2
            side="bottom"
            tooltipContent="Choose a VM model that fits your workload requirements. Different models are optimized for specific use cases like general purpose computing, memory-intensive tasks, or storage operations."
          >
            <span className="hidden @sm:inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-grey-dark-100 bg-grey-light-700 text-black transition-colors hover:bg-grey-90 hover:text-primary-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400 dark:hover:border-black-100 dark:hover:bg-black-300 dark:hover:text-primary-50">
              <InfoCircle className="size-4" />
            </span>
          </CustomTooltip2>
        </div>
        <Button
          onClick={() => openUrl(VM_DOCS_URL)}
          variant="primaryLight"
          size="auto"
          className="gap-[10px] px-[16px] py-[8px] text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
        >
          Help me create?
        </Button>
      </div>
      <div className=" flex flex-col  overflow-hidden">
        {/* Category tabs — full-width inline buttons matching Figma
          4542:50279 (dark) / 4542:49762 (light). Each tab is flex-1 so the
          bar spans the full width on every breakpoint and never overflows. */}
        <div className=" pt-2 pb-4 px-2 rounded-t-lg border border-b-0 bg-grey-light-300 dark:bg-black-primary-bg shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)] border-grey-dark-100 dark:border-black-300">
          <div className="flex w-full items-center gap-[3.831px] rounded-[6.13px] border-[0.766px] border-grey-dark-100 bg-[#ebebeb] p-1 dark:border-black-300 dark:bg-black-900 h-8">
            {categories.map((category) => {
              const isActive = activeCategory === category;
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setActiveCategory(category)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center justify-center rounded-[3.065px] border-[0.766px] px-[12px] transition-colors",
                    "font-medium text-[12px] leading-[1.109] tracking-[-0.24px] whitespace-nowrap font-geist",
                    isActive
                      ? "h-6 border-grey-dark-100 bg-grey-light-300 text-black-900 shadow-[0px_12.26px_3.831px_0px_rgba(0,0,0,0),0px_8.429px_3.065px_0px_rgba(0,0,0,0.01),0px_4.597px_3.065px_0px_rgba(0,0,0,0.04),0px_2.299px_2.299px_0px_rgba(0,0,0,0.08),0px_0.766px_0.766px_0px_rgba(0,0,0,0.09)] dark:border-black-300 dark:bg-black-primary-bg dark:text-white"
                      : "h-6 border-transparent text-[#4d4d4d] hover:text-black-900 dark:text-grey-light-100 dark:opacity-50 dark:hover:opacity-100",
                  )}
                >
                  <span className="truncate">{category}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div
          className={cn(
            "flex flex-col w-full overflow-hidden rounded-lg border border-grey-dark-100 -mt-2 bg-white dark:bg-black-600 dark:border-black-300 p-2",
          )}
        >
          <div className="animate-in fade-in duration-300">
            {/* Templates Grid */}
            {isBetaError ? (
              <NoEntriesFound className="h-[max(31.25rem,55vh)]">
                <div className="text-center">
                  <p className="text-grey-30 font-semibold mb-1 text-base dark:text-white">
                    Feature Not Available
                  </p>
                  <p className="text-grey-50 text-sm">{betaAccessMessage}</p>
                </div>
              </NoEntriesFound>
            ) : isFlavorsLoading ? (
              <div className="grid grid-cols-1 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 gap-4">
                {Array.from({ length: 8 }).map((_, index) => (
                  <VMTemplateCardSkeleton key={`skeleton-${index}`} />
                ))}
              </div>
            ) : templates.length === 0 ? (
              <NoEntriesFound title="No templates available" />
            ) : (
              <>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 gap-4">
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
          </div>
        </div>
      </div>
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

"use client";

import React, { useState } from "react";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { VMTemplate } from "./vm-template-card";
import CreateSSHKeyModal, {
  CreateSSHKeyData,
} from "../ssh-keys-table/create-ssh-key-modal";
import Step1Configuration from "./step1-configuration";
import Step2Summary from "./step2-summary";
import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { CpuCharge } from "@/components/ui/icons";
import useCreateSSHKey from "@/app/lib/hooks/api/useCreateSSHKey";
import useSSHKeys from "@/app/lib/hooks/api/useSSHKeys";
import useVMImages from "@/app/lib/hooks/api/useVMImages";
import useCreateVM, {
  type CreateVMRequest,
} from "@/app/lib/hooks/api/useCreateVM";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";
import useVMApplications from "@/app/lib/hooks/api/useVMApplications";

type FieldName = "instanceName" | "operatingSystem" | "image" | "sshKey";

type FieldErrors = Partial<Record<FieldName, string>>;

export interface VMConfigurationData {
  instanceName: string;
  operatingSystem: string;
  image: string;
  applicationId?: string;
  sshKey: string;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: VMConfigurationData) => void;
  template: VMTemplate | null;
  isLoading?: boolean;
};

const CreateVMModal: React.FC<Props> = ({
  open,
  onClose,
  onSubmit,
  template,
  isLoading = false,
}) => {
  const [currentStep, setCurrentStep] = useState<1 | 2>(1);

  const [instanceName, setInstanceName] = useState("");
  const [operatingSystem, setOperatingSystem] = useState("");
  const [image, setImage] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  const [openCreateSSHKeyModal, setOpenCreateSSHKeyModal] = useState(false);

  // Fetch VM images from API
  const { data: vmImages, isLoading: isLoadingImages } = useVMImages();

  // Fetch VM one-click applications from API
  const {
    data: vmApplications,
    isLoading: isLoadingApplications,
    isFetching: isFetchingApplications,
  } = useVMApplications();

  // Fetch SSH keys from API
  const {
    data: sshKeysData,
    isLoading: loadingSSHKeys,
    isFetching: isFetchingSSHKeys,
    refetch: refetchSSHKeys,
  } = useSSHKeys({
    page: 1,
    page_size: 100, // Get all keys for dropdown
  });
  const isLoadingSSHKeys = loadingSSHKeys || isFetchingSSHKeys;
  const isLoadingVMApps = isLoadingApplications || isFetchingApplications;

  // Use create SSH key mutation
  const { mutateAsync: createSSHKey, isPending: isCreatingSSHKey } =
    useCreateSSHKey();

  // Use create VM mutation
  const { mutateAsync: createVM, isPending: isCreatingVM } = useCreateVM();

  // Tracks the in-flight `check_action_eligibility` IPC so the submit
  // button shows a disabled/loading state during the round-trip. The
  // threshold lives in Rust at `crate::billing::eligibility::thresholds::
  // VM_CREATION` and `create_vm` enforces it via `require_eligible(...)?`,
  // so this UX gate is just to avoid the user landing on a failed spawn.
  const [isChecking, setIsChecking] = useState(false);
  const { checkEligibility } = useCreditCheck();

  // Extract unique operating systems from VM images
  const operatingSystems = React.useMemo(() => {
    if (!vmImages) return [];
    const osMap = new Map<string, string>();

    vmImages.forEach((img) => {
      const osName = img.name.split(" ")[0]; // Extract OS name (e.g., "Ubuntu" from "Ubuntu 22.04 LTS")
      const osKey = osName.toLowerCase();
      if (!osMap.has(osKey)) {
        osMap.set(osKey, osName);
      }
    });

    return Array.from(osMap.entries()).map(([value, label]) => ({
      value,
      label,
    }));
  }, [vmImages]);

  // Filter images based on selected operating system
  const filteredImages = React.useMemo(() => {
    if (!vmImages) return [];

    if (!operatingSystem) {
      return vmImages.map((img) => ({
        value: img.slug,
        label: img.name,
      }));
    }

    return vmImages
      .filter((img) => img.name.toLowerCase().startsWith(operatingSystem))
      .map((img) => ({
        value: img.slug,
        label: img.name,
      }));
  }, [vmImages, operatingSystem]);

  const applicationOptions = React.useMemo(() => {
    if (!vmApplications?.length) return [];

    return vmApplications.map((app) => ({
      value: app.id.toString(),
      label: app.name,
      // SelectOption.imageUrl is `string | undefined`; the backend may now
      // return `null` for apps without a curated logo, so coalesce.
      imageUrl: app.logo_url ?? undefined,
    }));
  }, [vmApplications]);

  // Convert SSH keys to options format
  const sshKeyOptions = React.useMemo(() => {
    if (!sshKeysData?.results?.length) {
      return [];
    }
    return sshKeysData.results.map((key) => ({
      value: key.id.toString(),
      label: key.name,
    }));
  }, [sshKeysData]);

  const resetForm = () => {
    setCurrentStep(1);
    setInstanceName("");
    setOperatingSystem("");
    setImage("");
    setApplicationId("");
    setSshKey("");
    setErrors({});
  };

  const clearFieldError = (field: FieldName) => {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const updated = { ...prev };
      delete updated[field];
      return updated;
    });
  };

  const handleInstanceNameChange = (value: string) => {
    setInstanceName(value);
    clearFieldError("instanceName");
  };

  const handleOSChange = (value: string) => {
    const isCurrentImageValidForOS = vmImages?.some(
      (img) => img.slug === image && img.name.toLowerCase().startsWith(value),
    );

    setOperatingSystem(value);
    if (!isCurrentImageValidForOS) {
      setImage(""); // Clear image selection when OS changes (unless still compatible)
    }
    clearFieldError("operatingSystem");
    if (isCurrentImageValidForOS) {
      clearFieldError("image");
    }
  };

  const handleImageChange = (value: string) => {
    setImage(value);
    clearFieldError("image");
  };

  const handleApplicationChange = (value: string) => {
    setApplicationId(value);
  };

  const handleSshKeyChange = (value: string) => {
    setSshKey(value);
    clearFieldError("sshKey");
  };

  const handleNext = () => {
    const newErrors: FieldErrors = {};

    if (!instanceName.trim()) {
      newErrors.instanceName = "Instance Name is required";
    }
    if (!operatingSystem) {
      newErrors.operatingSystem = "Operating System is required";
    }
    if (!image) {
      newErrors.image = "Image is required";
    }
    if (!sshKey) {
      newErrors.sshKey = "SSH Key is required";
    }

    if (Object.keys(newErrors).length) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    setCurrentStep(2);
  };

  const handleBack = () => {
    setCurrentStep(1);
  };

  const handleSubmit = async () => {
    try {
      // Live Rust eligibility check. Threshold (≥ 10 credits) lives in
      // `crate::billing::eligibility::thresholds::VM_CREATION` — the only
      // place that number is allowed to live now.
      setIsChecking(true);
      let eligible = false;
      try {
        eligible = await checkEligibility("vm-creation");
      } finally {
        setIsChecking(false);
      }
      if (!eligible) {
        return;
      }

      // Find the selected image ID from the slug
      const selectedImage = vmImages?.find((img) => img.slug === image);
      if (!selectedImage) {
        toast.error("Selected image not found", {
          duration: Infinity,
          closeButton: true,
        });
        return;
      }

      const selectedApplication = applicationId
        ? vmApplications?.find((app) => app.id.toString() === applicationId)
        : undefined;

      if (applicationId && !selectedApplication) {
        toast.error("Selected application not found", {
          duration: Infinity,
          closeButton: true,
        });
        return;
      }

      // Find the selected SSH key's public key
      const selectedSSHKey = sshKeysData?.results?.find(
        (key) => key.id.toString() === sshKey,
      );
      if (!selectedSSHKey) {
        toast.error("Selected SSH key not found", {
          duration: Infinity,
          closeButton: true,
        });
        return;
      }

      // Get the flavor ID from the template
      if (!template) {
        toast.error("No VM template selected", {
          duration: Infinity,
          closeButton: true,
        });
        return;
      }

      // Create the VM
      const payload: CreateVMRequest = {
        flavor_id: Number(template.id),
        image_id: selectedImage.id,
        ssh_public_key: selectedSSHKey.public_key,
        name: instanceName,
      };

      if (selectedApplication) {
        payload.application_id = selectedApplication.id;
      }

      await createVM(payload);

      toast.success("Virtual Machine Created Successfully");

      // Pass data to parent component
      onSubmit({
        instanceName,
        operatingSystem,
        image,
        applicationId: selectedApplication?.id.toString() || undefined,
        sshKey,
      });

      resetForm();
    } catch (error) {
      // Display error toast that persists until manually dismissed
      const errorMessage =
        error instanceof Error ? error.message : "Failed to create VM";
      toast.error(errorMessage, {
        duration: Infinity,
        closeButton: true,
      });
      console.error("Error creating VM:", error);
    }
  };

  const handleClose = () => {
    if (isCreatingVM) return;
    resetForm();
    onClose();
  };

  const handleCreateSSHKey = async (data: CreateSSHKeyData) => {
    try {
      const newKey = await createSSHKey({
        name: data.keyName,
        public_key: data.publicKey,
      });
      toast.success("SSH Key created successfully!");
      setOpenCreateSSHKeyModal(false);
      // Refetch SSH keys to update the dropdown
      await refetchSSHKeys();
      // Automatically select the newly created key
      if (newKey?.id) {
        setSshKey(newKey.id.toString());
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create SSH key",
      );
      throw error; // Re-throw so modal knows it failed
    }
  };

  const getSelectedImageLabel = () => {
    const selectedImage = vmImages?.find((img) => img.slug === image);
    return selectedImage?.name || "-";
  };

  const getSelectedOSLabel = () => {
    const selectedOS = operatingSystems.find(
      (os) => os.value === operatingSystem,
    );
    return selectedOS?.label || operatingSystem || "-";
  };

  const getSelectedApplicationLabel = () => {
    if (!applicationId) return "-";
    const selectedApp = applicationOptions.find(
      (app) => app.value === applicationId,
    );
    return selectedApp?.label || "-";
  };

  return (
    <>
      <FramedDialog
        open={open && !openCreateSSHKeyModal}
        onClose={handleClose}
        title={template?.name || "Create Virtual Machine"}
        icon={<CpuCharge className="size-[18px] text-white" />}
        maxWidth="max-w-[611px]"
        contentClassName="px-4 pb-4 pt-4 sm:w-full sm:px-4 sm:pb-4 sm:pt-4"
        titleClassName="mb-0 text-[24px] leading-9 tracking-[-0.48px] sm:text-[28px] sm:leading-9"
      >
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[18px] font-medium leading-[21px] tracking-[-0.36px] text-black-900 dark:text-white sm:text-base sm:leading-[22px] sm:tracking-[-0.32px]">
              {currentStep === 1 ? "Model Configuration" : "Summary"}
            </h3>
            <span className="inline-flex rounded-full bg-primary-50/[0.12] px-2 py-1 text-xs font-medium leading-[18px] tracking-[-0.24px] text-primary-50 sm:px-3 dark:bg-primary-65/[0.18] dark:text-primary-65">
              Step {currentStep}/2
            </span>
          </div>

          {currentStep === 1 ? (
            <Step1Configuration
              instanceName={instanceName}
              setInstanceName={handleInstanceNameChange}
              operatingSystem={operatingSystem}
              handleOSChange={handleOSChange}
              image={image}
              setImage={handleImageChange}
              applicationId={applicationId}
              setApplicationId={handleApplicationChange}
              sshKey={sshKey}
              setSshKey={handleSshKeyChange}
              operatingSystems={operatingSystems}
              filteredImages={filteredImages}
              applicationOptions={applicationOptions}
              sshKeyOptions={sshKeyOptions}
              onCreateSSHKey={() => setOpenCreateSSHKeyModal(true)}
              isLoadingImages={isLoadingImages}
              isLoadingApplications={isLoadingVMApps}
              isLoadingSSHKeys={isLoadingSSHKeys}
              errors={errors}
            />
          ) : (
            <Step2Summary
              template={template}
              instanceName={instanceName}
              operatingSystemLabel={getSelectedOSLabel()}
              imageLabel={getSelectedImageLabel()}
              applicationLabel={getSelectedApplicationLabel()}
            />
          )}

          <div className="space-y-4 sm:space-y-3">
            {currentStep === 1 ? (
              <Button
                type="button"
                onClick={handleNext}
                disabled={isLoading || isLoadingImages || isLoadingSSHKeys}
                variant="primary"
                size="auto"
                className="h-[52px] w-full gap-2 rounded-[6px] px-4 text-[18px] font-medium leading-5 tracking-[-0.36px] shadow-[0px_4px_4px_0px_rgba(4,65,149,0.1)]"
              >
                <span>Next</span>
                <ArrowRight className="size-[18px]" strokeWidth={2} />
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  onClick={handleSubmit}
                  disabled={isLoading || isCreatingVM || isChecking}
                  variant="primary"
                  size="auto"
                  className="h-[52px] w-full gap-2 rounded-[6px] px-4 text-[18px] font-medium leading-5 tracking-[-0.36px] shadow-[0px_4px_4px_0px_rgba(4,65,149,0.1)]"
                >
                  {isChecking ? (
                    <span>Checking credits...</span>
                  ) : isCreatingVM ? (
                    <span>Creating...</span>
                  ) : (
                    <>
                      <span className="sm:hidden">Create VM</span>
                      <span className="hidden sm:inline">
                        Create Virtual Machine
                      </span>
                      <ArrowRight className="size-[18px]" strokeWidth={2} />
                    </>
                  )}
                </Button>

                <Button
                  type="button"
                  onClick={handleBack}
                  disabled={isLoading || isCreatingVM || isChecking}
                  size="auto"
                  dotColor="rgba(0, 0, 0, 0.37)"
                  className="h-[52px] w-full rounded-[8px] border border-grey-80 bg-white px-4 text-[18px] font-normal leading-5 tracking-[-0.36px] text-grey-10 hover:rounded-[8px] hover:bg-grey-90 dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#373737]"
                >
                  Back
                </Button>
              </>
            )}
          </div>
        </div>
      </FramedDialog>

      {/* SSH Key Creation Modal */}
      <CreateSSHKeyModal
        open={openCreateSSHKeyModal}
        onClose={() => setOpenCreateSSHKeyModal(false)}
        onSubmit={handleCreateSSHKey}
        isLoading={isCreatingSSHKey}
      />
    </>
  );
};

export default CreateVMModal;

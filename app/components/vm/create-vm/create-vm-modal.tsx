"use client";

import React, { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { VMTemplate } from "./vm-template-card";
import CreateSSHKeyModal, {
  CreateSSHKeyData,
} from "../ssh-keys-table/create-ssh-key-modal";
import Step1Configuration from "./step1-configuration";
import Step2Summary from "./step2-summary";
import { Button } from "@/components/ui/button";
import { Button as Button2 } from "@/components/ui/button/NewButton";
import useCreateSSHKey from "@/app/lib/hooks/api/useCreateSSHKey";
import useSSHKeys from "@/app/lib/hooks/api/useSSHKeys";
import useVMImages from "@/app/lib/hooks/api/useVMImages";
import useCreateVM, {
  type CreateVMRequest,
} from "@/app/lib/hooks/api/useCreateVM";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { useSetAtom } from "jotai";
import { insufficientCreditsDialogOpenAtom } from "@/app/components/page-sections/files/atoms/query-atoms";
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
  const [currentStep, setCurrentStep] = useState(1);
  const [direction, setDirection] = useState(0); // -1 for back, 1 for forward

  const [instanceName, setInstanceName] = useState("");
  const [operatingSystem, setOperatingSystem] = useState("");
  const [image, setImage] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  const [openCreateSSHKeyModal, setOpenCreateSSHKeyModal] = useState(false);
  const [isStepTransitioning, setIsStepTransitioning] = useState(false);
  const stepTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

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

  // Fetch user credits
  const {
    data: credits,
    isFetching: isCreditsFetching,
    isLoading: isCreditsLoading,
  } = useUserCredits();
  const setInsufficientCreditsReason = useSetAtom(insufficientCreditsDialogOpenAtom);

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
      imageUrl: app.logo_url,
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
    setDirection(0);
    setErrors({});
    setIsStepTransitioning(false);

    if (stepTransitionTimeoutRef.current) {
      clearTimeout(stepTransitionTimeoutRef.current);
      stepTransitionTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (stepTransitionTimeoutRef.current) {
        clearTimeout(stepTransitionTimeoutRef.current);
        stepTransitionTimeoutRef.current = null;
      }
    };
  }, []);

  const goToStep = (nextStep: 1 | 2, nextDirection: number) => {
    if (stepTransitionTimeoutRef.current) {
      clearTimeout(stepTransitionTimeoutRef.current);
      stepTransitionTimeoutRef.current = null;
    }

    setIsStepTransitioning(true);
    setDirection(nextDirection);
    setCurrentStep(nextStep);

    stepTransitionTimeoutRef.current = setTimeout(() => {
      setIsStepTransitioning(false);
      stepTransitionTimeoutRef.current = null;
    }, 350);
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
      (img) => img.slug === image && img.name.toLowerCase().startsWith(value)
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
    goToStep(2, 1);
  };

  const handleBack = () => {
    goToStep(1, -1);
  };

  const handleSubmit = async () => {
    try {
      // Check if credits are loading
      if (isCreditsLoading || isCreditsFetching) {
        toast.error("Credits Loading", {
          description: "Please wait while we load your credits balance.",
          duration: Infinity,
          closeButton: true,
        });
        return;
      }

      // Check if user has at least 10 credits
      if (credits !== undefined) {
        const creditsNumber = Number(credits) / Math.pow(10, 18);
        if (creditsNumber < 10) {
          setInsufficientCreditsReason("vm-creation");
          return;
        }
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
        (key) => key.id.toString() === sshKey
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
        error instanceof Error ? error.message : "Failed to create SSH key"
      );
      throw error; // Re-throw so modal knows it failed
    }
  };

  const variants = {
    enter: (direction: number) => ({
      opacity: 0,
      x: direction > 0 ? 20 : -20,
    }),
    center: {
      opacity: 1,
      x: 0,
    },
    exit: (direction: number) => ({
      opacity: 0,
      x: direction > 0 ? -20 : 20,
    }),
  };

  const getSelectedImageLabel = () => {
    const selectedImage = filteredImages.find((img) => img.value === image);
    return selectedImage?.label || "";
  };

  const getSelectedOSLabel = () => {
    const selectedOS = operatingSystems.find(
      (os) => os.value === operatingSystem
    );
    return selectedOS?.label || "";
  };

  const getSelectedApplicationLabel = () => {
    if (!applicationId) return "Not selected";
    const selectedApp = applicationOptions.find(
      (app) => app.value === applicationId
    );
    return selectedApp?.label || "Not selected";
  };

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(o) => !o && !isCreatingVM && handleClose()}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
          <Dialog.Content asChild>
            <div
              className="
              fixed left-1/2 top-1/2 z-50
              w-full max-w-sm sm:max-w-[30.625rem]
              -translate-x-1/2 -translate-y-1/2
            "
            >
              <motion.div
                layout={isStepTransitioning ? "size" : false}
                transition={{
                  layout: { duration: 0.3, ease: "easeInOut" },
                }}
                onLayoutAnimationComplete={() => setIsStepTransitioning(false)}
                className="
                w-full
                max-h-[90vh]
                bg-white rounded-[0.5rem]
                shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
                border border-grey-80
                overflow-hidden flex flex-col min-h-0
              "
              >
                {/* Header */}
                <div className="border-b border-grey-80 flex gap-2 items-center justify-between px-4 py-3">
                  <Dialog.Title className="flex-1 text-2xl font-medium text-grey-10">
                    {template?.name || "Create Virtual Machine"}
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <button
                      aria-label="Close"
                      disabled={isCreatingVM}
                      className="text-grey-10 hover:text-grey-20 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <CloseCircle className="size-6" />
                    </button>
                  </Dialog.Close>
                </div>

                {/* Step Header */}
                <div className="flex items-center justify-between px-4 py-3">
                  <h3 className="text-lg font-medium text-grey-10">
                    {currentStep === 1 ? "Model Configuration" : "Summary"}
                  </h3>
                  <div className="bg-primary-100 border border-primary-80 rounded px-2 py-1">
                    <p className="text-xs font-medium text-primary-40">
                      Step {currentStep} of 2
                    </p>
                  </div>
                </div>

                {/* Animated Content */}
                <motion.div
                  className={[
                    "relative px-4 flex-1 min-h-0 overflow-x-hidden",
                    isStepTransitioning
                      ? "overflow-y-hidden pointer-events-none"
                      : "overflow-y-auto",
                    "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:h-0",
                  ].join(" ")}
                  initial={false}
                >
                  <AnimatePresence
                    initial={false}
                    custom={direction}
                    mode="popLayout"
                  >
                    {currentStep === 1 ? (
                      <motion.div
                        key="step1"
                        custom={direction}
                        variants={variants}
                        initial="enter"
                        animate="center"
                        exit="exit"
                        transition={{
                          x: {
                            type: "tween",
                            duration: 0.3,
                            ease: "easeInOut",
                          },
                          opacity: { duration: 0.25 },
                        }}
                      >
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
                      </motion.div>
                    ) : (
                      <motion.div
                        key="step2"
                        custom={direction}
                        variants={variants}
                        initial="enter"
                        animate="center"
                        exit="exit"
                        transition={{
                          x: {
                            type: "tween",
                            duration: 0.3,
                            ease: "easeInOut",
                          },
                          opacity: { duration: 0.25 },
                        }}
                      >
                        <Step2Summary
                          template={template}
                          instanceName={instanceName}
                          operatingSystemLabel={getSelectedOSLabel()}
                          imageLabel={getSelectedImageLabel()}
                          applicationLabel={getSelectedApplicationLabel()}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>

                {/* Actions */}
                <div className="px-4 pb-4 pt-2 space-y-3">
                  {currentStep === 1 ? (
                    <Button
                      className={`flex gap-x-2 items-center  h-[3.75rem] w-full`}
                      onClick={handleNext}
                      disabled={
                        isLoading || isLoadingImages || isLoadingSSHKeys
                      }
                    >
                      {" "}
                      <div className="font-medium text-base leading-[1.375rem] tracking-tight">
                        Next
                      </div>
                    </Button>
                  ) : (
                    <>
                      <Button
                        className={`flex gap-x-2 items-center  h-[3.75rem] w-full`}
                        onClick={handleSubmit}
                        disabled={
                          isLoading ||
                          isCreatingVM ||
                          isCreditsLoading ||
                          isCreditsFetching
                        }
                      >
                        {" "}
                        <div className="font-medium text-base leading-[1.375rem] tracking-tight">
                          {isCreatingVM
                            ? "Creating..."
                            : "Create Virtual Machine"}
                        </div>
                      </Button>

                      <Button2
                        className="bg-grey-100  border border-grey-80 text-grey-10 w-full my-4 text-lg font-medium h-[3.5rem] hover:bg-grey-80 transition"
                        onClick={handleBack}
                        disabled={isLoading || isCreatingVM}
                      >
                        Go Back
                      </Button2>
                    </>
                  )}
                </div>
              </motion.div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

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

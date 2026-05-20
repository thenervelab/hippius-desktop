"use client";

import React, { useState } from "react";
import { ArrowRight } from "lucide-react";
import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { SelectOptions } from "@/components/ui/select/SelectOptions";
import { Image as ImageIcon } from "@/components/ui/icons";

export interface ChangeImageData {
  operatingSystem: string;
  image: string;
}

interface VMImage {
  id: number;
  name: string;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ChangeImageData) => void;
  isLoading?: boolean;
  /** VM images from the API. If not provided, the selectors will be empty. */
  images?: VMImage[];
};

// Re-uses the form metrics from CreateTicketModal / CreateVMModal so the
// VM-area dialogs feel like one family.
const labelClassName =
  "text-sm font-medium leading-5 tracking-[-0.28px] text-grey-dark-800 dark:text-[#a3a3a3]";

const controlClassName =
  "mt-1.5 min-h-14 items-center !shadow-none focus-within:!shadow-none dark:!shadow-none dark:focus-within:!shadow-none";

const ChangeImageModal: React.FC<Props> = ({
  open,
  onClose,
  onSubmit,
  isLoading = false,
  images = [],
}) => {
  const [operatingSystem, setOperatingSystem] = useState("");
  const [image, setImage] = useState("");

  // Derive OS list and image options from API data
  const operatingSystems = React.useMemo(() => {
    const osMap = new Map<string, string>();
    images.forEach((img) => {
      const osName = img.name.split(" ")[0];
      const osKey = osName.toLowerCase();
      if (!osMap.has(osKey)) osMap.set(osKey, osName);
    });
    return Array.from(osMap.entries()).map(([value, label]) => ({
      value,
      label,
    }));
  }, [images]);

  const allImages = React.useMemo(
    () =>
      images.map((img) => ({
        value: String(img.id),
        label: img.name,
        os: img.name.split(" ")[0].toLowerCase(),
      })),
    [images],
  );

  const filteredImages = operatingSystem
    ? allImages.filter((img) => img.os === operatingSystem)
    : allImages;

  const resetForm = () => {
    setOperatingSystem("");
    setImage("");
  };

  // Reset image selection when operating system changes
  const handleOSChange = (value: string) => {
    setOperatingSystem(value);
    setImage(""); // Clear image selection when OS changes
  };

  const handleSubmit = () => {
    if (!operatingSystem || !image) {
      return;
    }

    onSubmit({
      operatingSystem,
      image,
    });

    resetForm();
  };

  const handleClose = () => {
    if (isLoading) return;
    resetForm();
    onClose();
  };

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Change Image"
      icon={<ImageIcon className="size-[18px] text-white" />}
      maxWidth="max-w-[405px]"
      contentClassName="px-4 pb-4 pt-4 sm:w-full sm:px-4 sm:pb-4 sm:pt-4"
      titleClassName="mb-0 text-[22px] leading-8 tracking-normal sm:text-[28px] sm:leading-9"
    >
      <div className="mt-4 flex flex-col gap-4 font-geist">
        {/* Operating System */}
        <div>
          <label className={labelClassName}>Operating System</label>
          <SelectOptions
            value={operatingSystem}
            onValueChange={handleOSChange}
            options={operatingSystems}
            placeholder={
              operatingSystems.length === 0 ? "No OS available" : "Choose an OS"
            }
            disabled={operatingSystems.length === 0}
            triggerClassName={controlClassName}
            ariaLabel="Operating System"
          />
        </div>

        {/* Image */}
        <div>
          <label className={labelClassName}>Image</label>
          <SelectOptions
            value={image}
            onValueChange={setImage}
            options={filteredImages}
            placeholder={
              filteredImages.length === 0
                ? "No images available"
                : "Choose an image"
            }
            disabled={filteredImages.length === 0}
            triggerClassName={controlClassName}
            ariaLabel="Image"
          />
        </div>

        <div className="space-y-3 pt-1">
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isLoading || !operatingSystem || !image}
            variant="primary"
            size="auto"
            className="h-[52px] w-full gap-2 rounded-[6px] px-4 text-[18px] font-medium leading-5 tracking-[-0.36px] shadow-[0px_4px_4px_0px_rgba(4,65,149,0.1)]"
          >
            <span>{isLoading ? "Changing..." : "Change Image"}</span>
            {!isLoading ? (
              <ArrowRight className="size-[18px]" strokeWidth={2} />
            ) : null}
          </Button>

          <Button
            type="button"
            onClick={handleClose}
            disabled={isLoading}
            size="auto"
            dotColor="rgba(0, 0, 0, 0.37)"
            className="h-[52px] w-full rounded-[8px] border border-grey-80 bg-white px-4 text-[18px] font-normal leading-5 tracking-[-0.36px] text-grey-10 hover:rounded-[8px] hover:bg-grey-90 dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#373737]"
          >
            Cancel
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
};

export default ChangeImageModal;

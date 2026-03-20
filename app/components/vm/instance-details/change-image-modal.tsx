"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import TicketSelect from "../../page-sections/support/TicketSelect";

export interface ChangeImageData {
  operatingSystem: string;
  image: string;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ChangeImageData) => void;
  isLoading?: boolean;
};

const operatingSystems = [
  { value: "ubuntu", label: "Ubuntu" },
  { value: "debian", label: "Debian" },
  { value: "centos", label: "CentOS" },
  { value: "rocky", label: "Rocky Linux" },
];

const allImages = [
  { value: "ubuntu-22.04", label: "Ubuntu 22.04 LTS", os: "ubuntu" },
  { value: "ubuntu-24.04", label: "Ubuntu 24.04 LTS", os: "ubuntu" },
  { value: "debian-12", label: "Debian 12", os: "debian" },
  { value: "debian-11", label: "Debian 11", os: "debian" },
  { value: "centos-stream-9", label: "CentOS Stream 9", os: "centos" },
  { value: "rocky-9", label: "Rocky Linux 9", os: "rocky" },
];

const ChangeImageModal: React.FC<Props> = ({
  open,
  onClose,
  onSubmit,
  isLoading = false,
}) => {
  const [operatingSystem, setOperatingSystem] = useState("");
  const [image, setImage] = useState("");

  // Filter images based on selected operating system
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
    resetForm();
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-grey-100/60 z-50" />
        <Dialog.Content
          className="
            fixed left-1/2 top-1/2 z-50 
            w-full max-w-sm sm:max-w-[428px] 
            max-h-[90vh] overflow-y-auto
            -translate-x-1/2 -translate-y-1/2
            bg-grey-100 rounded-[8px]
            shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
            p-4 border border-grey-80
          "
        >
          <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
          <Dialog.Close asChild className="sm:hidden">
            <button
              aria-label="Close"
              className="absolute top-[30px] right-4 text-grey-10 hover:text-grey-20"
            >
              <CloseCircle className="size-6" />
            </button>
          </Dialog.Close>

          <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center max-sm:mt-2.5 mb-4">
            Change Image
          </Dialog.Title>

          <div className="space-y-4">
            {/* Operating System */}
            <div>
              <label className="text-sm font-medium text-grey-70">
                Operating System
              </label>
              <div className="mt-2">
                <TicketSelect
                  value={operatingSystem}
                  onValueChange={handleOSChange}
                  options={operatingSystems}
                  placeholder="Choose an OS"
                />
              </div>
            </div>

            {/* Image */}
            <div>
              <label className="text-sm font-medium text-grey-70">Image</label>
              <div className="mt-2">
                <TicketSelect
                  value={image}
                  onValueChange={setImage}
                  options={filteredImages}
                  placeholder="Choose an image"
                />
              </div>
            </div>
          </div>

          <div className="mt-6 space-y-3">
            <button
              onClick={handleSubmit}
              disabled={isLoading || !operatingSystem || !image}
              className="
                w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                hover:bg-primary-40 transition disabled:opacity-50 disabled:cursor-not-allowed
              "
            >
              <div className="py-2.5 rounded border border-primary-40 text-lg">
                {isLoading ? "Changing..." : "Change Image"}
              </div>
            </button>
            <Dialog.Close asChild>
              <button
                onClick={handleClose}
                disabled={isLoading}
                className="
                  w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10
                  hover:bg-grey-80 transition
                  text-lg font-medium hidden sm:block
                  disabled:opacity-50 disabled:cursor-not-allowed
                "
              >
                Cancel
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ChangeImageModal;

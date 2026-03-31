"use client";

import React from "react";
import { PlusCircle } from "lucide-react";
import TicketSelect from "../../page-sections/support/TicketSelect";
import ImageOptionSelect from "../../ui/select/ImageOptionSelect";
import CustomTooltip2 from "../../ui/CustomTooltip2";
import { openUrl } from "@tauri-apps/plugin-opener";

const VM_SSH_CONNECT_DOCS_URL =
  "https://docs.hippius.com/use/virtual-machines#connect-to-your-vm-via-ssh";
interface Step1Props {
  instanceName: string;
  setInstanceName: (value: string) => void;
  operatingSystem: string;
  handleOSChange: (value: string) => void;
  image: string;
  setImage: (value: string) => void;
  applicationId: string;
  setApplicationId: (value: string) => void;
  sshKey: string;
  setSshKey: (value: string) => void;
  operatingSystems: Array<{ value: string; label: string }>;
  filteredImages: Array<{ value: string; label: string }>;
  applicationOptions: Array<{
    value: string;
    label: string;
    imageUrl?: string;
  }>;
  sshKeyOptions: Array<{ value: string; label: string }>;
  onCreateSSHKey: () => void;
  isLoadingImages?: boolean;
  isLoadingApplications?: boolean;
  isLoadingSSHKeys?: boolean;
  errors?: Partial<{
    instanceName: string;
    operatingSystem: string;
    image: string;
    sshKey: string;
  }>;
}

const Step1Configuration: React.FC<Step1Props> = ({
  instanceName,
  setInstanceName,
  operatingSystem,
  handleOSChange,
  image,
  setImage,
  applicationId,
  setApplicationId,
  sshKey,
  setSshKey,
  operatingSystems,
  filteredImages,
  applicationOptions,
  sshKeyOptions,
  onCreateSSHKey,
  isLoadingImages = false,
  isLoadingApplications = false,
  isLoadingSSHKeys = false,
  errors = {},
}) => {
  return (
    <div className="space-y-4 py-4">
      {/* Instance Name */}
      <div>
        <label className="text-sm font-medium text-grey-70">
          Instance Name
        </label>
        <input
          type="text"
          value={instanceName}
          onChange={(e) => setInstanceName(e.target.value)}
          placeholder="Enter name of Instance"
          className="
            mt-2 w-full bg-white text-grey-60 placeholder-grey-60
            border border-grey-80 p-4 rounded-[0.5rem]
            focus:outline-none focus:border-grey-70 text-base font-medium
          "
        />
        {errors.instanceName && (
          <p className="mt-2 text-sm text-red-500">{errors.instanceName}</p>
        )}
      </div>

      {/* Operating System and Image Row */}
      <div className="grid grid-cols-2 gap-3">
        {/* Operating System */}
        <div>
          <label className="text-sm font-medium text-grey-70">
            Operating System
          </label>
          <div className="mt-2">
            <TicketSelect
              value={operatingSystem}
              onValueChange={handleOSChange}
              options={
                isLoadingImages || operatingSystems.length === 0
                  ? []
                  : operatingSystems
              }
              placeholder={
                isLoadingImages
                  ? "Loading..."
                  : operatingSystems.length === 0
                  ? "No OS available"
                  : "Choose an OS"
              }
              isLoading={isLoadingImages}
              disabled={isLoadingImages || operatingSystems.length === 0}
            />
          </div>
          {errors.operatingSystem && (
            <p className="mt-2 text-sm text-red-500">
              {errors.operatingSystem}
            </p>
          )}
        </div>

        {/* Image */}
        <div>
          <label className="text-sm font-medium text-grey-70">Image</label>
          <div className="mt-2">
            <TicketSelect
              value={image}
              onValueChange={setImage}
              options={
                isLoadingImages || filteredImages.length === 0
                  ? []
                  : filteredImages
              }
              placeholder={
                isLoadingImages
                  ? "Loading..."
                  : filteredImages.length === 0
                  ? "No images available"
                  : "Choose an image"
              }
              isLoading={isLoadingImages}
              disabled={isLoadingImages || filteredImages.length === 0}
            />
          </div>
          {errors.image && (
            <p className="mt-2 text-sm text-red-500">{errors.image}</p>
          )}
        </div>
      </div>

      {/* One-Click Application */}
      <div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-grey-70">
            Application (optional)
          </label>
          <CustomTooltip2
            showInfo
            tooltipContent={
              <div className="text-xs leading-snug">
                We&apos;ll set up the selected app when the VM is created. If
                you don&apos;t choose one, you&apos;ll get a plain VM with just
                the OS.
              </div>
            }
          />
        </div>
        <div className="mt-2">
          <ImageOptionSelect
            value={applicationId}
            onValueChange={setApplicationId}
            options={
              isLoadingApplications
                ? []
                : applicationOptions.length === 0
                ? []
                : applicationOptions
            }
            placeholder={
              isLoadingApplications
                ? "Loading..."
                : applicationOptions.length === 0
                ? "No applications available"
                : "Select Application"
            }
            isLoading={isLoadingApplications}
            disabled={isLoadingApplications || applicationOptions.length === 0}
          />
        </div>
      </div>

      {/* SSH Key */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <label className="text-sm font-medium text-grey-70">SSH Key</label>
          <CustomTooltip2
            showInfo={true}
            tooltipContent={
              <span>
                SSH keys provide secure access to your VM.{" "}
                <button
                  onClick={() => openUrl(VM_SSH_CONNECT_DOCS_URL)}
                  className="text-primary-50 hover:underline"
                >
                  Learn how to connect via SSH
                </button>
              </span>
            }
          />
        </div>
        <div className="mt-2">
          <TicketSelect
            value={sshKey}
            onValueChange={setSshKey}
            options={
              isLoadingSSHKeys || sshKeyOptions.length === 0
                ? []
                : sshKeyOptions
            }
            placeholder={
              isLoadingSSHKeys
                ? "Loading..."
                : sshKeyOptions.length === 0
                ? "No SSH keys found"
                : "Select your SSH key"
            }
            isLoading={isLoadingSSHKeys}
            disabled={isLoadingSSHKeys}
          />
        </div>
        {errors.sshKey && (
          <p className="mt-2 text-sm text-red-500">{errors.sshKey}</p>
        )}
      </div>

      {/* Create New SSH Key */}
      <button
        onClick={onCreateSSHKey}
        className="flex items-center gap-2 text-grey-10 hover:text-grey-20 transition"
      >
        <PlusCircle className="size-[1.125rem]" />
        <span className="text-base font-medium">Create New SSH Key</span>
      </button>
    </div>
  );
};

export default Step1Configuration;

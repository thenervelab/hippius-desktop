"use client";

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Input } from "@/components/ui/input";
import { SelectOptions } from "@/components/ui/select/SelectOptions";
import { AddSquare, InfoCircle } from "@/app/components/ui/icons";

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

// Field label styling mirrors the Create Ticket dialog so the two
// FramedDialog-based forms feel like one family.
const labelClassName =
  "text-sm font-medium leading-5 tracking-[-0.28px] text-grey-dark-800 dark:text-[#a3a3a3]";

const errorClassName =
  "mt-2 text-sm font-medium leading-5 tracking-[-0.28px] text-error-70";

// Strip the 4px shadow halo from inputFieldShellClassName for this dialog —
// the FramedDialog's blue chrome already provides containment, and the soft
// grey ring stacks too much visual weight on top of it. Same treatment as
// CreateTicketModal.
const controlClassName =
  "mt-1.5 min-h-14 items-center !shadow-none focus-within:!shadow-none dark:!shadow-none dark:focus-within:!shadow-none";

const controlTextClassName =
  "text-base leading-[22px] tracking-[-0.32px] placeholder:text-grey-dark-800 dark:placeholder:text-[#7d7d7d]";

// Inline tooltip used next to field labels — pixel-equivalent to the
// console's `<CustomTooltip variant="field-info" />`: 12px Geist Medium body
// in `#52525c` / dark `#a3a3a3`, white card with `border-grey-dark-100`, 8px
// radius, no arrow, soft 24px blur drop shadow. Rolling this locally rather
// than reusing CustomTooltip2 because that component pins its Content at
// z-50 and would render *under* FramedDialog's z-[61] surface; here we use
// z-[1000] to match console.
const FieldInfoTooltip: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <Tooltip.Provider delayDuration={200}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="inline-flex shrink-0 cursor-pointer items-center justify-center text-[#8f8f94] dark:text-[#a3a3a3]">
          <InfoCircle className="size-3.5" />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          sideOffset={6}
          className="z-[1000] w-max max-w-[260px] whitespace-normal break-words rounded-[8px] border border-grey-dark-100 bg-white px-3 py-[10px] text-[12px] font-medium leading-4 tracking-[-0.24px] text-[#52525c] shadow-[0px_4px_24px_0px_rgba(0,0,0,0.08)] transition-opacity duration-200 data-[state=closed]:opacity-0 data-[state=open]:opacity-100 dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-[#a3a3a3] dark:shadow-black/25"
        >
          {children}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
);

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
    <div className="space-y-2.5">
      {/* Instance Name */}
      <div>
        <label className={labelClassName}>Instance Name</label>
        <Input
          type="text"
          value={instanceName}
          onChange={(event) => setInstanceName(event.target.value)}
          placeholder="Enter name of Instance"
          aria-invalid={errors.instanceName ? true : undefined}
          wrapperClassName={controlClassName}
          className={controlTextClassName}
        />
        {errors.instanceName && (
          <p className={errorClassName}>{errors.instanceName}</p>
        )}
      </div>

      {/* Operating System and Image Row */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {/* Operating System */}
        <div className="min-w-0">
          <label className={labelClassName}>Operating System</label>
          <SelectOptions
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
            aria-invalid={errors.operatingSystem ? true : undefined}
            triggerClassName={controlClassName}
            ariaLabel="Operating System"
          />
          {errors.operatingSystem && (
            <p className={errorClassName}>{errors.operatingSystem}</p>
          )}
        </div>

        {/* Image */}
        <div className="min-w-0">
          <label className={labelClassName}>Image</label>
          <SelectOptions
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
            aria-invalid={errors.image ? true : undefined}
            triggerClassName={controlClassName}
            ariaLabel="Image"
          />
          {errors.image && <p className={errorClassName}>{errors.image}</p>}
        </div>
      </div>

      {/* One-Click Application — matches console: SelectOptions w/ image
          layout, 23×23 thumbnail per row */}
      <div>
        <div className="flex items-center gap-1.5">
          <label className={labelClassName}>Application (optional)</label>
          <FieldInfoTooltip>
            We&apos;ll set up the selected app when the VM is created. If you
            don&apos;t choose one, you&apos;ll get a plain VM with just the OS.
          </FieldInfoTooltip>
        </div>
        <SelectOptions
          value={applicationId}
          onValueChange={setApplicationId}
          options={
            isLoadingApplications || applicationOptions.length === 0
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
          triggerClassName={controlClassName}
          ariaLabel="Application"
          optionLayout="image"
        />
      </div>

      {/* SSH Key */}
      <div>
        <div className="mb-2 flex items-center gap-1.5">
          <label className={labelClassName}>SSH Key</label>
          <FieldInfoTooltip>
            SSH keys provide secure access to your VM.{" "}
            <button
              type="button"
              onClick={() => openUrl(VM_SSH_CONNECT_DOCS_URL)}
              className="text-primary-50 transition-colors hover:text-[#2454c4] hover:underline dark:text-primary-65 dark:hover:text-primary-brand-dark"
            >
              Learn how to connect via SSH
            </button>
          </FieldInfoTooltip>
        </div>
        <SelectOptions
          value={sshKey}
          onValueChange={setSshKey}
          options={
            isLoadingSSHKeys || sshKeyOptions.length === 0 ? [] : sshKeyOptions
          }
          placeholder={
            isLoadingSSHKeys
              ? "Loading..."
              : sshKeyOptions.length === 0
                ? "No SSH keys found"
                : "Select Your SSH Key"
          }
          isLoading={isLoadingSSHKeys}
          disabled={isLoadingSSHKeys}
          aria-invalid={errors.sshKey ? true : undefined}
          triggerClassName={controlClassName}
          ariaLabel="SSH Key"
        />
        {errors.sshKey && <p className={errorClassName}>{errors.sshKey}</p>}
      </div>

      {/* Create New SSH Key */}
      <button
        type="button"
        onClick={onCreateSSHKey}
        className="!mt-4 inline-flex items-center gap-2 text-black-900 transition-colors hover:text-grey-20 dark:text-white dark:hover:text-[#a3a3a3]"
      >
        <AddSquare className="size-5 shrink-0" />
        <span className="text-base font-medium leading-[22px] tracking-[-0.32px]">
          Create New SSH Key
        </span>
      </button>
    </div>
  );
};

export default Step1Configuration;

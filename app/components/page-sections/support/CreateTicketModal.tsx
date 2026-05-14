"use client";

import React, { forwardRef, useImperativeHandle, useState } from "react";
import { Trash2 } from "lucide-react";

import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import {
  Input,
  inputFieldControlClassName,
  inputFieldShellClassName,
} from "@/components/ui/input";
import { Ticket as TicketIcon, ImageUp } from "@/components/ui/icons";
import { SelectOptions, type SelectOption } from "@/components/ui/select/SelectOptions";
import { cn } from "@/lib/utils";
import { getFilePartsFromFileName } from "@/app/lib/utils/getFilePartsFromFileName";
import { selectFilePath } from "@/app/lib/utils/tauri";

export interface CreateTicketData {
  subject: string;
  priority: "low" | "medium" | "high";
  category: string;
  description: string;
  attachment?: { path: string; name: string } | null;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateTicketData) => void;
  isLoading?: boolean;
};

export const categories: SelectOption[] = [
  { value: "billing", label: "Account & Billing" },
  { value: "storage", label: "Storage (Arion & S3)" },
  { value: "general", label: "General" },
];

const severities: Array<{
  value: CreateTicketData["priority"];
  label: string;
}> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export interface CreateTicketModalRef {
  resetForm: () => void;
}

const labelClassName =
  "text-sm font-medium leading-5 tracking-[-0.28px] text-grey-dark-800 dark:text-[#a3a3a3]";

// Strip the 4px halo from inputFieldShellClassName for this dialog —
// the framed-blue-border dialog already gives controls plenty of visual
// containment, so the soft grey ring just adds noise.
const controlClassName =
  "mt-1.5 min-h-14 items-center !shadow-none focus-within:!shadow-none dark:!shadow-none dark:focus-within:!shadow-none";

const controlTextClassName =
  "text-base leading-[22px] tracking-[-0.32px] placeholder:text-grey-dark-800 dark:placeholder:text-[#7d7d7d]";

const truncateFilename = (rawName: string): string => {
  const { fileName, fileFormat } = getFilePartsFromFileName(rawName);

  if (rawName.length > 25) {
    return `${fileName.slice(0, 10)}...${fileName.slice(-6)}${
      fileFormat
        ? "." +
          (fileFormat.length > 6
            ? fileFormat.slice(0, 3) + "..."
            : fileFormat)
        : ""
    }`;
  }

  return rawName;
};

const CreateTicketModal = forwardRef<CreateTicketModalRef, Props>(
  ({ open, onClose, onSubmit, isLoading = false }, ref) => {
    const [subject, setSubject] = useState("");
    const [category, setCategory] = useState("");
    const [severity, setSeverity] = useState<CreateTicketData["priority"] | "">(
      ""
    );
    const [description, setDescription] = useState("");
    const [attachment, setAttachment] = useState<{
      path: string;
      name: string;
    } | null>(null);

    const resetForm = () => {
      setSubject("");
      setCategory("");
      setSeverity("");
      setDescription("");
      setAttachment(null);
    };

    useImperativeHandle(ref, () => ({
      resetForm,
    }));

    const handleSubmit = () => {
      if (!subject || !category || !severity || !description) {
        return;
      }

      onSubmit({
        subject,
        priority: severity,
        category,
        description,
        attachment,
      });
    };

    const handlePickAttachment = async () => {
      if (isLoading) return;
      const selected = await selectFilePath(true);
      if (selected) setAttachment(selected);
    };

    const handleRemoveAttachment = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setAttachment(null);
    };

    const handleClose = () => {
      resetForm();
      onClose();
    };

    const isSubmitDisabled =
      isLoading || !subject || !category || !severity || !description;

    return (
      <FramedDialog
        open={open}
        onClose={handleClose}
        title="Create a Ticket"
        icon={<TicketIcon className="size-[21.33px] text-white" />}
        maxWidth="max-w-[600px]"
      >
        <div className="flex flex-col gap-[10px] font-sans">
          <div>
            <label className={labelClassName}>Ticket Subject</label>
            <Input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Choose a subject for this ticket"
              disabled={isLoading}
              wrapperClassName={controlClassName}
              className={controlTextClassName}
            />
          </div>

          <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2">
            <div>
              <label className={labelClassName}>Ticket Category</label>
              <SelectOptions
                value={category}
                onValueChange={setCategory}
                options={categories}
                placeholder="Choose category"
                disabled={isLoading}
                triggerClassName={controlClassName}
                ariaLabel="Ticket category"
              />
            </div>

            <div>
              <label className={labelClassName}>Ticket Severity</label>
              <SelectOptions
                value={severity}
                onValueChange={(value) =>
                  setSeverity(value as CreateTicketData["priority"])
                }
                options={severities}
                placeholder="Choose severity"
                disabled={isLoading}
                triggerClassName={controlClassName}
                ariaLabel="Ticket severity"
              />
            </div>
          </div>

          <div>
            <label className={labelClassName}>Ticket Description</label>
            <div
              className={cn(
                inputFieldShellClassName,
                "mt-1.5 min-h-[126px] items-start",
                "!shadow-none focus-within:!shadow-none dark:!shadow-none dark:focus-within:!shadow-none",
                isLoading && "cursor-not-allowed opacity-60"
              )}
            >
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the issue you are facing"
                rows={3}
                disabled={isLoading}
                className={cn(
                  inputFieldControlClassName,
                  controlTextClassName,
                  "min-h-[94px] resize-none"
                )}
              />
            </div>
          </div>

          <div>
            {/* Tauri-native file picker. Button-as-row matches the Figma
                attachment pill (gray bg, image icon on the right, trash
                icon swap when a file is attached). */}
            <button
              type="button"
              onClick={handlePickAttachment}
              disabled={isLoading}
              className={cn(
                "flex h-12 w-full items-center justify-between rounded-[8px] bg-[#F4F4F4] px-4 py-3 text-grey-10 transition-colors hover:bg-[#EBEBEB] dark:bg-[#2C2C2C] dark:text-white dark:hover:bg-[#363636]",
                isLoading && "pointer-events-none opacity-60"
              )}
            >
              <div className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[14px] font-medium leading-[16.8px] text-grey-10 dark:text-white">
                  {attachment
                    ? truncateFilename(attachment.name)
                    : "Attach an Image"}
                </span>
              </div>

              {attachment ? (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="Remove attachment"
                  onClick={handleRemoveAttachment}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      handleRemoveAttachment(
                        e as unknown as React.MouseEvent
                      );
                    }
                  }}
                  className="ml-4 shrink-0 cursor-pointer text-grey-10/60 transition-colors hover:text-grey-10 dark:text-white/60 dark:hover:text-white"
                >
                  <Trash2 className="size-6" strokeWidth={1.75} />
                </span>
              ) : (
                <ImageUp className="ml-4 size-6 shrink-0 text-grey-10/60 dark:text-white/60" />
              )}
            </button>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitDisabled}
            variant="primary"
            size="auto"
            className="h-[52px] w-full rounded-[8px] px-4 text-[18px] font-medium leading-5 tracking-[-0.36px] shadow-[0px_4px_4px_0px_rgba(4,65,149,0.1)]"
          >
            {isLoading ? "Submitting..." : "Submit Ticket"}
          </Button>

          <Button
            type="button"
            onClick={handleClose}
            disabled={isLoading}
            variant="defaultStable"
            size="auto"
            dotColor="rgba(0, 0, 0, 0.37)"
            className="h-[52px] w-full rounded-[8px] border border-grey-80 bg-white px-4 text-[18px] font-normal leading-5 tracking-[-0.36px] text-grey-10 hover:bg-grey-90 hover:rounded-[8px] dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#373737]"
          >
            Cancel
          </Button>
        </div>
      </FramedDialog>
    );
  }
);

CreateTicketModal.displayName = "CreateTicketModal";

export default CreateTicketModal;

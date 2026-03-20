"use client";

import React, { useState, useImperativeHandle, forwardRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import { Trash2 } from "lucide-react";
import TicketSelect from "./TicketSelect";
import AttachSqaure from "../../ui/icons/AttachSquare";
import PictureFrame from "../../ui/icons/PictureFrame";
import { getFilePartsFromFileName } from "@/app/lib/utils/getFilePartsFromFileName";
import { selectFile } from "@/app/lib/utils/tauri";

export interface CreateTicketData {
  subject: string;
  priority: "low" | "medium" | "high";
  category: string;
  description: string;
  attachment?: File | null;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateTicketData) => void;
  isLoading?: boolean;
};

export const categories = [
  { value: "billing", label: "Account & Billing" },
  { value: "storage", label: "Storage (Arion & S3)" },
  { value: "general", label: "General" },
];

const severities = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export interface CreateTicketModalRef {
  resetForm: () => void;
}

const CreateTicketModal = forwardRef<CreateTicketModalRef, Props>(
  ({ open, onClose, onSubmit, isLoading = false }, ref) => {
    const [subject, setSubject] = useState("");
    const [category, setCategory] = useState("");
    const [severity, setSeverity] = useState("");
    const [description, setDescription] = useState("");
    const [attachment, setAttachment] = useState<File | null>(null);

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
        priority: severity as "low" | "medium" | "high",
        category,
        description,
        attachment,
      });

      // Form will be reset externally after successful submission
    };

    const handleSelectAttachment = async () => {
      const files = await selectFile(false, true);
      if (files && files.length > 0) {
        setAttachment(files[0]);
      }
    };

    const handleRemoveAttachment = () => {
      setAttachment(null);
    };

    const truncateFilename = (rawName: string): string => {
      const { fileName, fileFormat } = getFilePartsFromFileName(rawName);

      // Check the total name length
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
            w-full max-w-sm sm:max-w-[488px] 
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

            <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center max-sm:mt-2.5  mb-4">
              Create a Ticket
            </Dialog.Title>

            <div className="space-y-4">
              {/* Ticket Subject */}
              <div>
                <label className="text-sm font-medium text-grey-70">
                  Ticket Subject
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Choose a subject for this ticket"
                  className="
                  mt-2 w-full bg-grey-100 text-grey-60 placeholder-grey-60
                  border border-grey-80 p-4 rounded-[8px]
                  focus:outline-none focus:border-grey-80 text-base font-medium
                "
                />
              </div>

              {/* Category and Severity in one row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-grey-70">
                    Ticket Category
                  </label>
                  <div className="mt-2">
                    <TicketSelect
                      value={category}
                      onValueChange={setCategory}
                      options={categories}
                      placeholder="Choose category"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium text-grey-70">
                    Ticket Severity
                  </label>
                  <div className="mt-2">
                    <TicketSelect
                      value={severity}
                      onValueChange={setSeverity}
                      options={severities}
                      placeholder="Choose severity"
                    />
                  </div>
                </div>
              </div>

              {/* Ticket Description */}
              <div>
                <label className="text-sm font-medium text-grey-70">
                  Ticket Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the issue you are facing"
                  rows={4}
                  className="
                  mt-2 w-full bg-grey-100 text-grey-60 placeholder-grey-60
                  border border-grey-80 p-4 rounded-[8px]
                  focus:outline-none focus:border-grey-80 text-base font-medium
                  resize-none
                "
                />
              </div>

              {/* Add an Attachment */}
              <div>
                <label className="text-sm font-medium text-grey-70 block mb-2">
                  Add an Attachment
                </label>
                <div
                  onClick={handleSelectAttachment}
                  className="
                  flex items-center justify-between
                  w-full bg-grey-100 text-grey-10
                  border border-grey-80 p-4 rounded-[8px]
                  cursor-pointer hover:bg-grey-90 transition
                "
                >
                  <div className="flex items-center gap-2">
                    <PictureFrame className="size-5" />
                    <span className="text-base font-medium t">
                      {attachment
                        ? truncateFilename(attachment.name)
                        : "Attach a picture"}
                    </span>
                  </div>
                  {attachment ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        handleRemoveAttachment();
                      }}
                      className=" transition"
                    >
                      <Trash2 className="size-5" />
                    </button>
                  ) : (
                    <AttachSqaure className="size-5" />
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              <button
                onClick={handleSubmit}
                disabled={
                  isLoading ||
                  !subject ||
                  !category ||
                  !severity ||
                  !description
                }
                className="
                w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                hover:bg-primary-40 transition disabled:opacity-50 disabled:cursor-not-allowed
              "
              >
                <div className="py-2.5 rounded border border-primary-40 text-lg">
                  {isLoading ? "Submitting..." : "Submit Ticket"}
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
  }
);

CreateTicketModal.displayName = "CreateTicketModal";

export default CreateTicketModal;

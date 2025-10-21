"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, CloseCircle, HippiusLogo } from "@/components/ui/icons";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectScrollUpButton,
  SelectScrollDownButton,
} from "@/components/ui/select/Select2";

import { Graphsheet } from "@/app/components/ui";

export type ModalData = {
  address: string;
  role: "Upload" | "UploadDelete";
  seed?: string;
};

type Props = {
  open: boolean;
  address: string;
  role: ModalData["role"];
  onAddressChange: (address: string) => void;
  onRoleChange: (role: ModalData["role"]) => void;
  onClose: () => void;
  onSubmit: (data: ModalData) => void;
};

const roles = ["Upload", "UploadDelete"] as const;

// Helper function to format role display text
const formatRoleDisplay = (role: string): string => {
  return role === "UploadDelete" ? "Upload/Delete" : role;
};

export default function ApiKeyModal({
  open,
  address,
  role,
  onAddressChange,
  onRoleChange,
  onClose,
  onSubmit,
}: Props) {
  const handleSubmit = () => {
    onSubmit({ address, role });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
        <Dialog.Content
          className="
            fixed left-1/2 top-1/2 z-50 
            w-full max-w-sm sm:max-w-[488px] 
            -translate-x-1/2 -translate-y-1/2
            bg-white rounded-[8px]
            shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
            p-4
          "
        >
          <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
          <Dialog.Close asChild className="sm:hidden">
            <button
              aria-label="Close"
              className="absolute top-11 right-4 text-grey-10 hover:text-grey-20"
            >
              <CloseCircle className="size-6" />
            </button>
          </Dialog.Close>

          <div className="text-2xl font-medium text-grey-10 hidden md:flex flex-col items-center justify-center pb-2 pt-4 gap-4">
            <div className="size-14 flex justify-center items-center relative">
              <Graphsheet
                majorCell={{
                  lineColor: [31, 80, 189, 1.0],
                  lineWidth: 2,
                  cellDim: 200,
                }}
                minorCell={{
                  lineColor: [49, 103, 211, 1.0],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-lg absolute w-full h-full z-10" />
              <div className="h-8 w-8 rounded-lg flex items-center justify-center z-20 bg-primary-50">
                <HippiusLogo className="size-8 text-grey-100 rounded-lg" />
              </div>
            </div>
            <span className="text-center text-2xl text-grey-10 font-medium">
              Add API Key
            </span>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-grey-70">
                Address
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => onAddressChange(e.target.value)}
                placeholder="5HGVL91QASRXMzrxP5LZJ9ExA4pZ..."
                className="
                  mt-2 w-full bg-grey-100 text-grey-60 placeholder-grey-60
                  border border-grey-80 p-4 rounded-[8px]
                  focus:outline-none focus:border-grey-80 text-base font-medium
                "
              />
            </div>

            <div>
              <label className="text-sm font-medium text-grey-70">Permission</label>
              <div className="mt-2">
                <Select value={role} onValueChange={onRoleChange}>
                  <SelectTrigger
                    className="
                            w-full flex items-center justify-between relative
                            bg-grey-100 border border-grey-80 rounded-[8px]
                            px-4 py-3 text-base font-medium text-grey-60
                            h-[56px] focus:outline-none focus:border-grey-80
                        "
                  >
                    <SelectValue placeholder="Select role">
                      {formatRoleDisplay(role)}
                    </SelectValue>
                    <ChevronDown className="absolute size-5 right-4 top-1/2 -translate-y-1/2 text-grey-60 pointer-events-none" />
                  </SelectTrigger>

                  <SelectContent
                    className="
                            mt-1 bg-grey-100 border border-grey-80 rounded-[8px]
                            shadow-lg max-h-60 overflow-auto z-50 p-0
                        "
                  >
                    <SelectScrollUpButton />
                    <SelectPrimitive.Viewport className="p-0">
                      <SelectGroup>
                        {roles.map((r) => (
                          <SelectPrimitive.Item
                            key={r}
                            value={r}
                            className="
                              relative flex items-center
                              px-4 py-3
                              text-base font-medium text-grey-60
                              cursor-pointer
                              rounded-none
                              data-[highlighted]:bg-grey-90 data-[highlighted]:rounded data-[highlighted]:border-grey-90
                              data-[selected]:bg-grey-90 data-[selected]:rounded data-[selected]:border-grey-90
                            "
                          >
                            <SelectPrimitive.ItemText>
                              {formatRoleDisplay(r)}
                            </SelectPrimitive.ItemText>
                          </SelectPrimitive.Item>
                        ))}
                      </SelectGroup>
                    </SelectPrimitive.Viewport>
                    <SelectScrollDownButton />
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="mt-6 space-y-3">
            <button
              onClick={handleSubmit}
              className="
                w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40
                hover:bg-primary-40 transition
              "
            >
              <div className="py-2.5 rounded border border-primary-40 text-lg">
                Add API Key
              </div>
            </button>
            <Dialog.Close asChild>
              <button
                onClick={onClose}
                className="
                  w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10
                  hover:bg-grey-80 transition
                  text-lg font-medium hidden sm:block
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

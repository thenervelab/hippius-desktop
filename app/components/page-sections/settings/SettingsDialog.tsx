import { cn } from "@/lib/utils";
import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import { X } from "lucide-react";

interface SettingsWidthDialogProps {
  children: React.ReactNode;
  className?: string;
  heading: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SettingsWidthDialog: React.FC<SettingsWidthDialogProps> = ({
  children,
  className = "",
  heading,
  open,
  onOpenChange
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      {/* Fade backdrop */}
      <Dialog.Overlay
        forceMount
        className="fixed inset-0 z-40 bg-white/80 
                   data-[state=open]:animate-fade-in-0.2 data-[state=closed]:animate-fade-out-0.2"
      />

      {/* Full-width panel */}
      <Dialog.Content
        forceMount
        className={cn(
          "fixed inset-0 z-50 bg-grey-100 border border-grey-80 shadow-menu font-geist duration-300 data-[state=open]:animate-full-panel-in data-[state=closed]:animate-full-panel-out",
          className
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between py-1.5  ml-[223px] mt-2 mr-8 mb-[18px] ">
          <Dialog.Title className="text-2xl text-grey-10  font-medium">
            {heading}
          </Dialog.Title>
          <Dialog.Close className=" border-[0.7px] border-grey-80 flex justify-center items-center size-10 hover:bg-grey-90 transition-colors">
            <X className="size-4 text-grey-10" />
          </Dialog.Close>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto pl-[23px] pr-8 h-[calc(100%-70px)]">
          {children}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);

export default SettingsWidthDialog;

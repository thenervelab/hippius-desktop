import { cn } from "@/lib/utils";
import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import { Icons } from ".";

interface SidebarDialogProps {
  children: React.ReactNode;
  className?: string;
  heading: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SidebarDialog: React.FC<SidebarDialogProps> = ({
  children,
  className = "",
  heading,
  open,
  onOpenChange,
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      {/* Fade backdrop */}
      <Dialog.Overlay
        forceMount
        className="fixed inset-0 z-40 bg-white/80 
                   data-[state=open]:animate-fade-in-0.2 data-[state=closed]:animate-fade-out-0.2"
      />

      {/* Slide-in panel */}
      <Dialog.Content
        forceMount
        className={cn(
          "fixed top-4 right-4 bottom-4 w-full max-w-[360px] rounded-lg z-50 bg-grey-100 border border-grey-80 shadow-menu font-geist duration-300  data-[state=open]:animate-panel-in data-[state=closed]:animate-panel-out h-[calc(100% -32px)]",
          className
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-grey-80">
          <Dialog.Title className="text-[22px] text-grey-10 leading-8 font-medium">
            {heading}
          </Dialog.Title>
          <Dialog.Close className=" rounded-full hover:bg-grey-90 transition-colors">
            <Icons.CloseCircle className="size-6 text-grey-10" />
          </Dialog.Close>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-2 h-[calc(100%-60px)]">
          {children}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
);

export default SidebarDialog;

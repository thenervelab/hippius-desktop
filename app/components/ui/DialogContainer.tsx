import { cn } from "@/lib/utils";
import * as Dialog from "@radix-ui/react-dialog";
import React from "react";

interface DialogContainerProps {
  children: React.ReactNode;
  className?: string;
  maxWidth?: string;
}

const DialogContainer: React.FC<DialogContainerProps> = ({
  children,
  className = "",
}) => {
  return (
    <Dialog.Portal>
      {/* Backdrop */}
      <Dialog.Overlay className="fixed inset-0 bg-white/80 z-50 data-[state=open]:animate-fade-in-0.3" />
      {/* Modal Content */}
      <Dialog.Content
        className={cn(
          "fixed bottom-6 left-6 right-6 z-50 bg-grey-100 rounded sm:rounded-lg overflow-hidden data-[state=open]:animate-slide-up data-[state=closed]:animate-slide-down sm:data-[state=open]:animate-scale-in-95-0.2 sm:data-[state=closed]:animate-scale-out-95-0.2 font-geist shadow-menu border border-grey-80",
          className
        )}
      >
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
};

export default DialogContainer;

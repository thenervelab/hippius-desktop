"use client";

import React, { useState } from "react";
import { cn } from "@/app/lib/utils";
import { Icons } from "@/components/ui";
import { toast } from "sonner";

interface CopyCellProps {
  text: string;
  children: React.ReactNode;
  title: string;
  toastMessage?: string;
  className?: string;
  copyIconClassName?: string;
  checkIconClassName?: string;
  buttonClass?: string;
  isJustifyCenter?: boolean;
}

const CopyText: React.FC<CopyCellProps> = ({
  text,
  children,
  title,
  toastMessage,
  className,
  copyIconClassName,
  checkIconClassName,
  buttonClass,
  isJustifyCenter = false,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success(toastMessage ?? "Text Copied Successfully");
  };

  return (
    <div
      className={cn(
        "flex items-center truncate w-full",
        className,
        isJustifyCenter ? "justify-center" : "justify-between"
      )}
    >
      {children}
      <button
        onClick={handleCopy}
        className={cn(
          "ml-2 p-1 hover:text-gray-700 transition-colors",
          buttonClass
        )}
        title={title}
      >
        {copied ? (
          <Icons.Check
            className={cn("w-4 h-4 text-green-500", checkIconClassName)}
          />
        ) : (
          <Icons.Copy className={cn("w-4 h-4", copyIconClassName)} />
        )}
      </button>
    </div>
  );
};

export default CopyText;

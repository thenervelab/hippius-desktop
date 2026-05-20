"use client";

import React from "react";
import { VMTemplate } from "./vm-template-card";
import { Icons } from "../../ui";
import { cn } from "@/lib/utils";

interface Step2Props {
  template: VMTemplate | null;
  instanceName: string;
  operatingSystemLabel: string;
  imageLabel: string;
  applicationLabel: string;
}

const summaryLabelClassName =
  "text-sm font-medium leading-[18px] tracking-[-0.28px] text-[#a6a6ab] dark:text-[#7d7d7d]";

const summaryValueClassName =
  "text-right text-[15px] font-medium leading-[22px] tracking-[-0.3px] text-black-900 dark:text-white sm:text-base sm:tracking-[-0.32px]";

const getOperatingSystemIcon = (operatingSystemLabel: string) => {
  const normalizedLabel = operatingSystemLabel.toLowerCase();

  if (normalizedLabel.includes("ubuntu")) return Icons.Ubuntu;
  if (normalizedLabel.includes("debian")) return Icons.Debian;
  if (normalizedLabel.includes("centos")) return Icons.CentOS;
  if (normalizedLabel.includes("fedora")) return Icons.Fedora;
  if (normalizedLabel.includes("linux") || normalizedLabel.includes("alma")) {
    return Icons.Linux;
  }

  return null;
};

const Step2Summary: React.FC<Step2Props> = ({
  template,
  instanceName,
  operatingSystemLabel,
  imageLabel,
  applicationLabel,
}) => {
  const OperatingSystemIcon = getOperatingSystemIcon(operatingSystemLabel);

  return (
    <div className="rounded-[14px] bg-[#f4f4f4] p-4 font-geist dark:bg-[#2c2c2c]">
      <div className="space-y-2.5 sm:space-y-3">
        <div className="flex items-start justify-between gap-4">
          <p className={summaryLabelClassName}>Model</p>
          <span className="inline-flex rounded-[4px] bg-primary-50/[0.12] px-1.5 py-[3px] text-xs font-medium leading-[14px] tracking-[-0.24px] text-primary-50 sm:rounded-[6px] sm:px-2 sm:py-1 sm:text-sm sm:leading-4 sm:tracking-[-0.28px] dark:bg-primary-65/[0.18] dark:text-primary-65">
            {template?.name ?? "-"}
          </span>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className={summaryLabelClassName}>Instance Name</p>
          <p className={summaryValueClassName}>{instanceName || "-"}</p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className={summaryLabelClassName}>Operating System</p>
          <div className="flex items-center justify-end gap-2">
            <p className={summaryValueClassName}>
              {operatingSystemLabel || "-"}
            </p>
            {OperatingSystemIcon ? (
              <OperatingSystemIcon className="size-6 shrink-0 sm:size-[18px]" />
            ) : null}
          </div>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className={summaryLabelClassName}>Image</p>
          <p className={summaryValueClassName}>{imageLabel || "-"}</p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className={summaryLabelClassName}>Application</p>
          <p
            className={cn(
              summaryValueClassName,
              applicationLabel === "-" && "text-[#a6a6ab] dark:text-[#7d7d7d]",
            )}
          >
            {applicationLabel || "-"}
          </p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className={summaryLabelClassName}>Cost per Hour</p>
          <p className={summaryValueClassName}>{template?.price ?? "-"}</p>
        </div>
      </div>
    </div>
  );
};

export default Step2Summary;

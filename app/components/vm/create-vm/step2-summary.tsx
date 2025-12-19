"use client";

import React from "react";
import { VMTemplate } from "./vm-template-card";

interface Step2Props {
  template: VMTemplate | null;
  instanceName: string;
  operatingSystemLabel: string;
  imageLabel: string;
  applicationLabel: string;
}

const Step2Summary: React.FC<Step2Props> = ({
  template,
  instanceName,
  operatingSystemLabel,
  imageLabel,
  applicationLabel,
}) => {
  return (
    <div className="space-y-4 py-4">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <p className="text-lg font-medium text-grey-60">Model</p>
          <p className="text-lg font-medium text-grey-10 text-right">
            {template?.name}
          </p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className="text-lg font-medium text-grey-60">Instance Name</p>
          <p className="text-lg font-medium text-grey-10 text-right">
            {instanceName}
          </p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className="text-lg font-medium text-grey-60">Operating System</p>
          <p className="text-lg font-medium text-grey-10 text-right">
            {operatingSystemLabel}
          </p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className="text-lg font-medium text-grey-60">Image</p>
          <p className="text-lg font-medium text-grey-10 text-right">
            {imageLabel}
          </p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className="text-lg font-medium text-grey-60">Application</p>
          <p className="text-lg font-medium text-grey-10 text-right">
            {applicationLabel}
          </p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className="text-lg font-medium text-grey-60">Cost per Hour</p>
          <p className="text-lg font-medium text-grey-10 text-right">
            {template?.price}
          </p>
        </div>
      </div>
    </div>
  );
};

export default Step2Summary;

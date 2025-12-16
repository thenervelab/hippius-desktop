"use client";

import React from "react";
import { PlusCircle } from "lucide-react";
import TicketSelect from "../../page-sections/support/TicketSelect";

interface Step1Props {
  instanceName: string;
  setInstanceName: (value: string) => void;
  numberOfInstances: string;
  setNumberOfInstances: (value: string) => void;
  operatingSystem: string;
  handleOSChange: (value: string) => void;
  image: string;
  setImage: (value: string) => void;
  sshKey: string;
  setSshKey: (value: string) => void;
  operatingSystems: Array<{ value: string; label: string }>;
  filteredImages: Array<{ value: string; label: string }>;
  sshKeyOptions: Array<{ value: string; label: string }>;
  onCreateSSHKey: () => void;
  errors?: Partial<{
    instanceName: string;
    numberOfInstances: string;
    operatingSystem: string;
    image: string;
    sshKey: string;
  }>;
}

const Step1Configuration: React.FC<Step1Props> = ({
  instanceName,
  setInstanceName,
  numberOfInstances,
  setNumberOfInstances,
  operatingSystem,
  handleOSChange,
  image,
  setImage,
  sshKey,
  setSshKey,
  operatingSystems,
  filteredImages,
  sshKeyOptions,
  onCreateSSHKey,
  errors = {},
}) => {
  return (
    <div className="space-y-4 py-4">
      {/* Instance Name */}
      <div>
        <label className="text-sm font-medium text-grey-70">
          Instance Name
        </label>
        <input
          type="text"
          value={instanceName}
          onChange={(e) => setInstanceName(e.target.value)}
          placeholder="Enter name of Instance"
          className="
            mt-2 w-full bg-white text-grey-60 placeholder-grey-60
            border border-grey-80 p-4 rounded-[8px]
            focus:outline-none focus:border-grey-70 text-base font-medium
          "
        />
        {errors.instanceName && (
          <p className="mt-2 text-sm text-red-500">{errors.instanceName}</p>
        )}
      </div>

      {/* Number of Instances */}
      <div>
        <label className="text-sm font-medium text-grey-70">
          Number of Instances
        </label>
        <input
          type="number"
          value={numberOfInstances}
          onChange={(e) => setNumberOfInstances(e.target.value)}
          placeholder="Enter number of Instances eg 8"
          className="
            mt-2 w-full bg-white text-grey-60 placeholder-grey-60
            border border-grey-80 p-4 rounded-[8px]
            focus:outline-none focus:border-grey-70 text-base font-medium
            [&::-webkit-inner-spin-button]:appearance-none
            [&::-webkit-outer-spin-button]:appearance-none
          "
          style={{
            MozAppearance: "textfield",
          }}
        />
        {errors.numberOfInstances && (
          <p className="mt-2 text-sm text-red-500">
            {errors.numberOfInstances}
          </p>
        )}
      </div>

      {/* Operating System and Image Row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Operating System */}
        <div>
          <label className="text-sm font-medium text-grey-70">
            Operating System
          </label>
          <div className="mt-2">
            <TicketSelect
              value={operatingSystem}
              onValueChange={handleOSChange}
              options={operatingSystems}
              placeholder="Choose an OS"
            />
          </div>
          {errors.operatingSystem && (
            <p className="mt-2 text-sm text-red-500">
              {errors.operatingSystem}
            </p>
          )}
        </div>

        {/* Image */}
        <div>
          <label className="text-sm font-medium text-grey-70">Image</label>
          <div className="mt-2">
            <TicketSelect
              value={image}
              onValueChange={setImage}
              options={filteredImages}
              placeholder="Choose an image"
            />
          </div>
          {errors.image && (
            <p className="mt-2 text-sm text-red-500">{errors.image}</p>
          )}
        </div>
      </div>

      {/* SSH Key */}
      <div>
        <label className="text-sm font-medium text-grey-70">SSH Key</label>
        <div className="mt-2">
          <TicketSelect
            value={sshKey}
            onValueChange={setSshKey}
            options={sshKeyOptions}
            placeholder="Select your SSH key"
          />
        </div>
        {errors.sshKey && (
          <p className="mt-2 text-sm text-red-500">{errors.sshKey}</p>
        )}
      </div>

      {/* Create New SSH Key */}
      <button
        onClick={onCreateSSHKey}
        className="flex items-center gap-2 text-grey-10 hover:text-grey-20 transition"
      >
        <PlusCircle className="size-[18px]" />
        <span className="text-base font-medium">Create New SSH Key</span>
      </button>
    </div>
  );
};

export default Step1Configuration;

import React from "react";

export interface TemplateCellProps {
  value: {
    name: string;
    cpu: string;
    ram: string;
    gpu: string;
  };
}

const Divider = () => (
  <span className="inline-block h-[14px] w-px shrink-0 bg-[#e3e3e3] dark:bg-[#313131]" />
);

const TemplateCell: React.FC<TemplateCellProps> = ({ value }) => {
  return (
    <div className="flex items-center gap-[4px] min-w-0 overflow-hidden">
      <span className="font-medium text-[12px] tracking-[-0.24px] text-[#1d1d1d] dark:text-white whitespace-nowrap shrink-0">
        {value.name}
      </span>
      <span className="size-[2px] shrink-0 rounded-full bg-[#7d7d7d]" />
      <span className="font-medium text-[12px] tracking-[-0.24px] text-[#7d7d7d] whitespace-nowrap shrink-0">
        {value.cpu}
      </span>
      <Divider />
      <span className="font-medium text-[12px] tracking-[-0.24px] text-[#7d7d7d] whitespace-nowrap shrink-0">
        {value.ram} RAM
      </span>
      <Divider />
      <span className="font-medium text-[12px] tracking-[-0.24px] text-[#7d7d7d] whitespace-nowrap shrink-0">
        {value.gpu}
      </span>
    </div>
  );
};

export default TemplateCell;

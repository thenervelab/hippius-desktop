import React from "react";

export interface TemplateCellProps {
  value: {
    name: string;
    cpu: string;
    ram: string;
    gpu: string;
  };
}

const TemplateCell: React.FC<TemplateCellProps> = ({ value }) => {
  return (
    <div className="text-grey-60 text-xs">
      <span className="text-grey-20 font-semibold text-sm">{value.name}</span>
      <span className="text-grey-70 mx-1.5">•</span>
      {value.cpu} | {value.ram} RAM | {value.gpu}
    </div>
  );
};

export default TemplateCell;

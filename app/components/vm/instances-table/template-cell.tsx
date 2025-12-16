import React from "react";

export interface TemplateCellProps {
  value: {
    cpu: string;
    ram: string;
    gpu: string;
  };
}

const TemplateCell: React.FC<TemplateCellProps> = ({ value }) => {
  return (
    <div className="text-grey-60 text-xs">
      {value.cpu} | {value.ram} | {value.gpu}
    </div>
  );
};

export default TemplateCell;

import React, { ReactNode } from "react";

interface FilterLabelProps {
  children: ReactNode;
}

const FilterLabel: React.FC<FilterLabelProps> = ({ children }) => (
  <label className="text-sm leading-5 text-grey-70 mb-2">{children}</label>
);

export default FilterLabel;

import React from "react";

interface LabelWithIconProps {
  icon: React.ReactNode;
  label: string;
}

const LabelWithIcon: React.FC<LabelWithIconProps> = ({ icon, label }) => {
  return (
    <div className="flex items-center gap-2 mb-2 text-grey-60">
      <div>{icon}</div>
      <span className="text-sm">{label}</span>
    </div>
  );
};

export default LabelWithIcon;

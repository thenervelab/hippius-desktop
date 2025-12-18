import React from "react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { P } from "@/components/ui/typography";

interface InfoPanelProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  headerAction?: React.ReactNode;
}

const InfoPanel: React.FC<InfoPanelProps> = ({
  title,
  icon,
  children,
  headerAction,
}) => {
  return (
    <div className="border border-grey-80 rounded-md overflow-hidden">
      <div className="flex items-center gap-2 p-4 border-b border-grey-80">
        <AbstractIconWrapper className="size-7 flex items-center justify-center">
          {icon}
        </AbstractIconWrapper>
        <P size="md" className="truncate">
          {title}
        </P>
        {headerAction && <div className="ml-auto">{headerAction}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
};

export default InfoPanel;

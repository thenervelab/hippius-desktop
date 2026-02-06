"use client";

import { useSetAtom } from "jotai";
import { RESET } from "jotai/utils";
import { ReactNode, useEffect } from "react";
import { dashboardPageHeaderAtom } from "./dashboardAtoms";

const DashboardTitleWrapper: React.FC<{
  children: ReactNode;
  mainText: string;
  subText?: string;
  infoTooltip?: ReactNode;
  rightContent?: ReactNode;
}> = ({ children, mainText, subText, infoTooltip, rightContent }) => {
  const setTitle = useSetAtom(dashboardPageHeaderAtom);
  useEffect(() => {
    setTitle({ mainText, subText, infoTooltip, rightContent });
    return () => {
      setTitle(RESET);
    };
  }, [setTitle, mainText, subText, infoTooltip, rightContent]);
  return children;
};

export default DashboardTitleWrapper;

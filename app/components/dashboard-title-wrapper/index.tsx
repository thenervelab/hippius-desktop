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
}> = ({ children, mainText, subText, infoTooltip }) => {
  const setTitle = useSetAtom(dashboardPageHeaderAtom);
  useEffect(() => {
    setTitle({ mainText, subText, infoTooltip });
    return () => {
      setTitle(RESET);
    };
  }, [setTitle, mainText, subText, infoTooltip]);
  return children;
};

export default DashboardTitleWrapper;

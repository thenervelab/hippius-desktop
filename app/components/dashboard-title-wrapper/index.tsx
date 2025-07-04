"use client";

import { useSetAtom } from "jotai";
import { RESET } from "jotai/utils";
import { ReactNode, useEffect } from "react";
import { dashboardPageHeaderAtom } from "./dashboardAtoms";

const DashboardTitleWrapper: React.FC<{
  children: ReactNode;
  mainText: string;
  subText?: string;
}> = ({ children, mainText, subText }) => {
  const setTitle = useSetAtom(dashboardPageHeaderAtom);
  useEffect(() => {
    setTitle({ mainText, subText });
    return () => {
      setTitle(RESET);
    };
  }, [setTitle, mainText, subText]);
  return children;
};

export default DashboardTitleWrapper;

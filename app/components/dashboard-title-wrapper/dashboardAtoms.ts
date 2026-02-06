import { atomWithReset } from "jotai/utils";
import { ReactNode } from "react";

export const dashboardPageHeaderAtom = atomWithReset<{
  mainText: string;
  subText?: string;
  infoTooltip?: ReactNode;
  rightContent?: ReactNode;
}>({
  mainText: "Welcome to Hippius",
  subText: "Your decentralized storage solution",
});

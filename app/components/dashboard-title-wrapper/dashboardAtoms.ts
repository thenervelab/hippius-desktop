import { atomWithReset } from "jotai/utils";

export const dashboardPageHeaderAtom = atomWithReset<{
  mainText: string;
  subText?: string;
}>({
  mainText: "Welcome to Hippius",
  subText: "Your decentralized storage solution",
});

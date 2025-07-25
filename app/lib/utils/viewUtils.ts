import { useAtomValue } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";

export const useIsPrivateView = (): boolean => {
  const activeSubMenuItem = useAtomValue(activeSubMenuItemAtom);
  return activeSubMenuItem === "Private";
};

import { useSetAtom } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";

export function useFilesNavigation() {
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);

  // Navigate to the files view
  const navigateToFilesView = () => {
    setActiveSubMenuItem("");
  };

  return {
    navigateToFilesView,
  };
}

"use client";

import { FC } from "react";
import { useAtomValue } from "jotai";
import FeatureDisabledRedirect from "@/components/FeatureDisabledRedirect";
import TrashView from "@/components/page-sections/trash/TrashView";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";

/**
 * `/trash`: behind the server's `drive_trash` capability. Nothing renders
 * while the capabilities are unknown, so a deep link is not bounced to the
 * overview before the answer lands.
 */
const TrashPage: FC = () => {
  const capabilities = useAtomValue(serverCapabilitiesAtom);
  if (capabilities === null || capabilities === undefined) return null;
  return (
    <FeatureDisabledRedirect enabled={capabilities.drive_trash === true}>
      <TrashView />
    </FeatureDisabledRedirect>
  );
};

export default TrashPage;

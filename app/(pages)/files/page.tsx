"use client";

import { Drive } from "@/components/page-sections";
import { FC, useEffect } from "react";
import PageHeader from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { PricingCard } from "@/components/ui/icons";
import { useSetAtom } from "jotai";

import InfoTooltip from "@/components/ui/info-tooltip";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";

const DRIVE_DOCS_URL = "https://docs.hippius.com/use/desktop/drive";

const FilesPage: FC = () => {
  // The inline FileDetailsPanel is mounted at the layout level
  // (ResponsiveContent) so it stays pinned to the available screen height
  // instead of scrolling with the page. We just need to clear the panel
  // atom on unmount so a selection from this page doesn't bleed into other
  // routes if the user navigates away with the panel still open.
  const setFileDetails = useSetAtom(fileDetailsPanelAtom);
  useEffect(() => {
    return () => setFileDetails(null);
  }, [setFileDetails]);
  return (
    <>
      <PageHeader
        hideStats={true}
        infoTooltip={
          <InfoTooltip
            ariaLabel="Drive information"
            align="start"
            contentClassName="max-w-[280px]"
            learnMoreUrl={DRIVE_DOCS_URL}
          >
            Every folder you sync from this computer shows up here. Files are
            encrypted on your device before they upload, so only your unlock
            password can open them.
          </InfoTooltip>
        }
        title="Your Files"
        className="!shadow-none"
        subtitle="All uploaded files are private and securely encrypted."
        actions={
          // The Drive page hides the header's stats card (and with it the
          // card's Subscription Plans button), so the plans page gets its own
          // persistent entry here — visible in the cards view and inside
          // every local or remote drive alike.
          <Button
            asLink
            href="/drive-plans"
            variant="raised"
            size="auto"
            className="flex items-center gap-2 px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
          >
            <PricingCard className="size-4" />
            Subscription Plans
          </Button>
        }
      />
      <Drive />
    </>
  );
};

export default FilesPage;

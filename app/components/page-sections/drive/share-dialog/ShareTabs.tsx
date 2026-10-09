"use client";

// By email | By link, the box at the top of the Share dialog. Both let
// somebody in, so they are one choice with two answers rather than two
// sections: tabs over one box, only one form showing at a time.
//
// The app's tab tray (`TabList`) in its accessible mode, stretched to the
// dialog's width so the two halves read as one control. Both panels stay
// mounted, so an address typed under By email is still there after a look
// at By link; `TabPanel` really hides the other one. The tab chosen is
// remembered for the session (`shareDialogTabAtom`), and Manage access's
// "Invite" and "New link" pick it before opening the dialog.

import React, { useId } from "react";
import { useAtom } from "jotai";
import { Link2, Mail } from "lucide-react";
import TabList from "@/components/ui/tabs/TabList";
import TabPanel from "@/components/ui/tabs/TabPanel";
import { shareDialogTabAtom, type ShareDialogTab } from "@/app/lib/global-atoms/sharesAtoms";

const TABS: { tabKey: ShareDialogTab; tabName: string; icon: React.ReactNode }[] = [
  { tabKey: "email", tabName: "By email", icon: <Mail className="size-3.5" aria-hidden /> },
  { tabKey: "link", tabName: "By link", icon: <Link2 className="size-3.5" aria-hidden /> },
];

export function ShareTabs({
  email,
  link,
  notice,
}: {
  email: React.ReactNode;
  link: React.ReactNode;
  /** Shown under the tabs, above either form (the full-drive warning). */
  notice?: React.ReactNode;
}) {
  const [tab, setTab] = useAtom(shareDialogTabAtom);
  const idBase = useId();

  return (
    <div className="flex min-w-0 flex-col gap-3" data-share-add="">
      <TabList
        idBase={idBase}
        ariaLabel="How to share"
        tabs={TABS}
        activeTab={tab}
        onTabChange={(next) => setTab(next as ShareDialogTab)}
        className="flex w-full min-w-0"
        width="min-w-0 flex-1"
        height="h-8"
        showTooltip={false}
      />
      {notice}
      <TabPanel idBase={idBase} tabKey="email" activeTab={tab} className="min-w-0">
        {email}
      </TabPanel>
      <TabPanel idBase={idBase} tabKey="link" activeTab={tab} className="min-w-0">
        {link}
      </TabPanel>
    </div>
  );
}

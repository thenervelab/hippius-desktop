"use client";

// Shown on the sign-in screen after Rust signed the account out because this
// computer was unlinked from another device. One button: there is nothing to
// decide, only something to know.

import { useEffect, useId, useState } from "react";
import { useAtomValue } from "jotai";
import { Unlink } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import {
  deviceUnlinkedNoticeAtom,
  forgetDeviceUnlinkedNotice,
  storedDeviceUnlinkedNotice,
} from "@/app/lib/global-atoms/deviceUnlinkedAtoms";

export const DEVICE_UNLINKED_TITLE = "This computer was unlinked";
export const DEVICE_UNLINKED_BODY =
  "It was removed from your account on another device. Sign in again to link it back. Everything it uploaded stays in your drive.";

export default function DeviceUnlinkedNotice() {
  const flagged = useAtomValue(deviceUnlinkedNoticeAtom);
  const bodyId = useId();
  // Read after mount: storage is not there during the static prerender, and
  // reading it in render would make the two disagree.
  const [stored, setStored] = useState(false);
  useEffect(() => {
    setStored(storedDeviceUnlinkedNotice());
  }, []);

  const close = () => {
    forgetDeviceUnlinkedNotice();
    setStored(false);
  };

  return (
    <FramedDialog
      open={flagged || stored}
      onClose={close}
      title={DEVICE_UNLINKED_TITLE}
      icon={<Unlink className="size-[18px] text-white" strokeWidth={2.5} />}
      maxWidth="max-w-[585px]"
      contentClassName="sm:w-[405px]"
      cardClassName="bg-white dark:bg-[#161616]"
      describedBy={bodyId}
    >
      <div className="font-geist">
        <p
          id={bodyId}
          className="mb-4 text-center text-base font-medium leading-[22px] tracking-[-0.32px] text-grey-20 dark:text-grey-dark-700"
        >
          {DEVICE_UNLINKED_BODY}
        </p>
        <Button variant="primary" className="h-[52px] w-full" onClick={close}>
          OK
        </Button>
      </div>
    </FramedDialog>
  );
}

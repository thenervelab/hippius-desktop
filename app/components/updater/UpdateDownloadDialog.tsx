"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle, HippiusLogo } from "@/components/ui/icons";
import { X } from "lucide-react";
import Image from "next/image";
import { CardButton, Graphsheet, Icons } from "../ui";
import { useAtomValue, useSetAtom } from "jotai";
import {
  updateStore,
  updateDialogOpenAtom,
  updateInfoAtom,
  confirmUpdate,
  closeUpdateDialog,
} from "@/app/components/updater/updateStore";
import RevealTextLine from "../ui/reveal-text-line";
import { InView } from "react-intersection-observer";

type Props = {
  onClose?: () => void;
};

export function useDesktopAppDialog() {
  const open = useAtomValue(updateDialogOpenAtom, { store: updateStore });
  const setOpen = useSetAtom(updateDialogOpenAtom, { store: updateStore });

  const closeDialog = () => {
    closeUpdateDialog();
  };

  return {
    open,
    setOpen,
    closeDialog,
  };
}

export default function DesktopAppDownloadDialog({ onClose }: Props) {
  const { open, closeDialog } = useDesktopAppDialog();
  const updateInfo = useAtomValue(updateInfoAtom, { store: updateStore });

  const handleClose = () => {
    closeDialog();
    confirmUpdate(false);
    if (onClose) onClose();
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.preventDefault();
    confirmUpdate(true);
    closeDialog();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />
        <Dialog.Content
          className="
        fixed left-1/2 top-1/2 z-50 
        w-full max-w-[1100px] h-[calc(100vh-100px)] md:h-[567px]
        -translate-x-1/2 -translate-y-1/2
          "
        >
          <Dialog.Title className="sr-only">
            Download Hippius Desktop App
          </Dialog.Title>

          <div
            className="bg-white rounded-[8px]
            shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
            border border-grey-80 mx-6 h-full relative max-md:overflow-y-scroll"
          >
            <div className="absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
            <Dialog.Close className="max-md:hidden absolute top-4 right-4 border-[0.7px] border-grey-80 flex justify-center items-center size-10 hover:bg-grey-90 transition-colors">
              <X className="size-4 text-grey-10" />
            </Dialog.Close>

            {/* Two divs with 48px gap */}
            <InView triggerOnce>
              {({ inView, ref }) => (
                <div
                  ref={ref}
                  className="grid grid-cols-1 max-md:p-4 md:grid-cols-2 md:gap-6  lg:gap-12  w-full h-full  md:pr-4"
                >
                  <button
                    aria-label="Close"
                    className=" text-grey-10 hover:text-grey-20 md:hidden py-4 flex justify-end"
                  >
                    <CloseCircle className="size-6" />
                  </button>
                  <div className=" bg-primary-100 md:rounded-tl-lg md:rounded-bl-lg relative h-full max-md:h-[359px] ">
                    <div className={"absolute w-full  top-0 h-full opacity-5 "}>
                      <Graphsheet
                        majorCell={{
                          lineColor: [31, 80, 189, 1.0],
                          lineWidth: 2,
                          cellDim: 150,
                        }}
                        minorCell={{
                          lineColor: [49, 103, 211, 1.0],
                          lineWidth: 1,
                          cellDim: 15,
                        }}
                        className="absolute w-full left-0 h-full duration-500"
                      />
                    </div>
                    <div className="relative w-full  h-full">
                      <RevealTextLine
                        rotate
                        reveal={inView}
                        parentClassName="w-full h-full"
                        className="delay-200 w-full h-full overflow-hidden"
                      >
                        <Image
                          src="/desktop-app-homepage.png"
                          alt="Desktop App frontend view"
                          fill
                          className="object-contain object-center w-[380px] md:scale-110"
                        />
                      </RevealTextLine>
                    </div>
                  </div>

                  <div className="bg-grey-100 flex flex-col mt-9">
                    <div>
                      {/* Icon */}
                      <div className="flex items-center">
                        <div className="flex items-center justify-center h-[56px] w-[56px] relative">
                          <Graphsheet
                            majorCell={{
                              lineColor: [31, 80, 189, 1],
                              lineWidth: 2,
                              cellDim: 40,
                            }}
                            minorCell={{
                              lineColor: [31, 80, 189, 1],
                              lineWidth: 2,
                              cellDim: 40,
                            }}
                            className="absolute w-full h-full top-0 bottom-0 left-0 duration-300 opacity-10 block"
                          />
                          <div className="flex items-center justify-center size-8 bg-primary-50 rounded-[8px] relative">
                            <HippiusLogo className="size-5 text-white" />
                          </div>
                        </div>
                      </div>
                      <div className="mt-6">
                        <RevealTextLine
                          rotate
                          reveal={inView}
                          className="delay-200"
                        >
                          <span className="text-success-50 font-geist text-base lg:text-[18px]">
                            Update Available
                          </span>
                        </RevealTextLine>
                      </div>
                      <h1 className="text-[28px] lg:text-[40px] leading-[48px] text-grey-10 mt-2">
                        <RevealTextLine
                          rotate
                          reveal={inView}
                          className="delay-300"
                        >
                          <span className="font-medium text-grey-30">
                            {" "}
                            New Update Available -
                          </span>{" "}
                        </RevealTextLine>
                        <br />
                        <RevealTextLine
                          rotate
                          reveal={inView}
                          className="delay-400"
                        >
                          <span className="text-primary-40 font-semibold">
                            Install Now
                          </span>
                        </RevealTextLine>
                      </h1>
                      <RevealTextLine
                        rotate
                        reveal={inView}
                        className="delay-500"
                      >
                        <p className="text-grey-60 font-medium text-base mt-2">
                          Version {updateInfo?.version || "0.0.1"} is now
                          available for download.
                        </p>
                      </RevealTextLine>
                      {updateInfo?.body && (
                        <div className="flex gap-2 flex-col font-medium mt-3 text-grey-50">
                          <RevealTextLine
                            rotate
                            reveal={inView}
                            className="delay-600"
                          >
                            <div className="flex gap-2">
                              <Icons.Note2 className="size-6" />
                              <span className="text-lg">Release Notes</span>
                            </div>
                          </RevealTextLine>
                          <RevealTextLine
                            rotate
                            reveal={inView}
                            className="delay-700"
                          >
                            <p className="text-sm">{updateInfo.body}</p>
                          </RevealTextLine>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col gap-4 mt-7">
                      <RevealTextLine
                        rotate
                        reveal={inView}
                        className="delay-800"
                      >
                        <CardButton
                          variant="dialog"
                          className="w-[208px] h-[48px] py-4 text-base"
                          onClick={handleDownload}
                        >
                          Update Now
                        </CardButton>
                      </RevealTextLine>
                    </div>
                  </div>
                </div>
              )}
            </InView>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

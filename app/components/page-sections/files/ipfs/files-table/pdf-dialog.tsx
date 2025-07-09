/* eslint-disable @next/next/no-img-element */
import React, { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { Icons } from "@/components/ui";
import { toast } from "sonner";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";
import { Image as LucideImage } from "lucide-react";

export const PdfDialogTrigger: React.FC<{
  children: ReactNode;
  onClick: () => void;
}> = ({ children, onClick }) => {
  return (
    <button
      onClick={onClick}
      className="px-4 py-[22px] relative group overflow-hidden flex items-center w-full"
    >
      <span>{children}</span>
      <div className="absolute pointer-events-none right-4 pl-16 bg-gradient-to-r from-transparent translate-x-6 opacity-0 duration-300 group-hover:translate-x-0 group-hover:opacity-100 to-white">
        <Icons.Eye className="size-5 text-primary-60 [&>path]:stroke-[3px]" />
      </div>
    </button>
  );
};

const PdfDialog: React.FC<{
  file: null | FormattedUserIpfsFile;
  onCloseClicked: () => void;
}> = ({ file, onCloseClicked }) => {
  return (
    <Dialog.Root
      open={!!file}
      onOpenChange={(o) => {
        if (!o) {
          onCloseClicked();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="bg-white/90 fixed p-3 sm:p-10 md:p-20 z-[999] top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3 backdrop-blur-xl">
          <Dialog.Content className="h-full max-w-screen-1.5xlˆ text-grey-10 w-full flex flex-col items-center">
            {(() => {
              if (file) {
                const pdfUrl = `https://get.hippius.network/ipfs/${decodeHexCid(
                  file.cid
                )}`;

                return (
                  <>
                    <div className="absolute flex justify-center top-4 px-2 sm:px-6 animate-fade-in-0.3 left-0 right-0">
                      <div className="flex justify-between gap-2 sm:gap-6 w-full ">
                        <Dialog.Title className="data-[state=open] font-medium flex items-center gap-x-2 w-full text-xl">
                          <div className="size-7 bg-primary-80 rounded flex items-center justify-center">
                            <LucideImage />
                          </div>
                          <span
                            title={file.name}
                            className="truncate max-sm:max-w-[180px]"
                          >
                            {file.name}
                          </span>
                        </Dialog.Title>

                        <div className="flex gap-x-4 items-center">
                          <button
                            onClick={() => {
                              downloadIpfsFile(file);
                            }}
                            className="flex hover:opacity-40 duration-300 text-sm font-medium gap-x-2 items-center bg-white whitespace-nowrap rounded border border-grey-80 p-2"
                          >
                            <Icons.DocumentDownload className="size-4 min-w-4" />
                            <span className="max-sm:hidden">Download File</span>
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(pdfUrl).then(() => {
                                toast.success(
                                  "Copied to clipboard successfully!"
                                );
                              });
                            }}
                            className="size-9 border hover:opacity-40 duration-300 border-grey-8 flex items-center justify-center rounded"
                          >
                            <Icons.Link className="size-5 [&>path]:stroke-2" />
                          </button>
                          <button
                            className="hover:opacity-40 duration-300"
                            onClick={onCloseClicked}
                          >
                            <Icons.CloseCircle className="size-7 [&>path]:stroke-2 text-grey-10" />
                          </button>
                        </div>
                      </div>
                    </div>
                    <div
                      onClick={onCloseClicked}
                      className="w-full h-full flex items-center justify-center"
                    >
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="border-4 relative shadow-dialog bg-white flex w-full h-full flex-col border-grey-80 bg-background-1 rounded-[8px] overflow-hidden animate-scale-in-95-0.4"
                      >
                        <iframe
                          src={pdfUrl}
                          width="100%"
                          height="100%"
                          className="border-none"
                        />
                      </div>
                    </div>
                  </>
                );
              }
            })()}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default PdfDialog;

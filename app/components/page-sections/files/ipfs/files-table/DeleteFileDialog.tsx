import * as Dialog from "@radix-ui/react-dialog";
import { Icons, P, Button } from "@/components/ui";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import useDeleteIpfsFile from "@/lib/hooks/use-delete-ipfs-file";
import React from "react";
import { toast } from "sonner";

const DeleteFileDialog: React.FC<{
  fileToDelete: FormattedUserIpfsFile | null;
  setFileToDelete: (v: FormattedUserIpfsFile | null) => void;
}> = ({ setFileToDelete, fileToDelete }) => {
  const { mutateAsync: deleteFile, isPending: isDeleting } = useDeleteIpfsFile({
    cid: fileToDelete?.cid || "",
  });

  return (
    <Dialog.Root
      open={!!fileToDelete}
      onOpenChange={(v) => {
        if (!v) {
          setFileToDelete(null);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="bg-white/70 fixed p-4 z-30 top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3">
          <Dialog.Content className="border shadow-dialog bg-white flex flex-col max-w-[428px] border-grey-80 bg-background-1 rounded-2xl overflow-hidden w-full relative data-[state=open]:animate-scale-in-95-0.2">
            <Dialog.Title className="hidden">Delete File</Dialog.Title>
            <div className="flex p-4 items-center text-grey-10 border-b border-grey-80 relative">
              <div className="lg:text-xl flex w-full 2xl:text-2xl font-medium relative">
                <span className="capitalize">Delete File</span>
              </div>
              <button
                className="ml-auto"
                onClick={() => {
                  setFileToDelete(null);
                }}
              >
                <Icons.CloseCircle className="size-7 relative" />
              </button>
            </div>
            <div className="grow max-h-[calc(85vh-120px)] p-4 text-grey-50 overflow-y-auto">
              <P className="my-4 text-center">
                Are you sure you want to delete <br />
                <span className="text-grey-10 font-semibold">
                  {fileToDelete?.name}
                </span>
              </P>

              <div className="flex gap-4">
                <Button
                  loading={isDeleting}
                  disabled={isDeleting}
                  className="w-full mt-4"
                  onClick={() => {
                    deleteFile()
                      .then(() => {
                        toast.success("Request submitted. File will be deleted!");
                        setFileToDelete(null);
                      })
                      .catch((error) => {
                        console.error("Delete error:", error);
                        toast.error(error.message || "Failed to delete file");
                      });
                  }}
                >
                  Yes, Delete
                </Button>
                <Button
                  variant="ghost"
                  className="w-full mt-4"
                  onClick={() => {
                    setFileToDelete(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
export default DeleteFileDialog;

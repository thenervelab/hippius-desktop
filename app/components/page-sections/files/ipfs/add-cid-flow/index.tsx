import { Button } from "@/components/ui";
import { P } from "@/components/ui/typography";
import { useAtomValue, useSetAtom } from "jotai";
import { Plus, Trash2 } from "lucide-react";
import { useState, FC } from "react";
import { toast } from "sonner";
import {
  submitFilesToBlockchainAtom,
  uploadToIpfsAndSubmitToBlockcahinRequestStateAtom,
  uploadFileCIDsToIpfsAtom,
  uploadProgressAtom,
  insufficientCreditsDialogOpenAtom
} from "@/components/page-sections/files/ipfs/atoms/query-atoms";
import { useUserCredits } from "@/lib/hooks/use-user-credits";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { generateId } from "@/lib/utils/generateId";
import useUserIpfsFiles from "@/lib/hooks/use-user-ipfs-files";

type Entry = {
  id: string;
  cid: string;
  name: string;
};

const AddCidFlow: FC<{
  reset: () => void;
}> = ({ reset }) => {
  const [ipfsFilesToAdd, setIpfsFilesToAdd] = useState<Entry[]>([
    { id: generateId(), cid: "", name: "" },
  ]);
  const { refetch: getUserCredits } = useUserCredits();
  const { refetch: refetchUserFiles } = useUserIpfsFiles();


  const { mutateAsync: submitFiles } = useAtomValue(
    submitFilesToBlockchainAtom
  );

  const { mutateAsync: uploadFileCids } = useAtomValue(
    uploadFileCIDsToIpfsAtom
  );

  const setRquestState = useSetAtom(
    uploadToIpfsAndSubmitToBlockcahinRequestStateAtom
  );

  const setUploadProgress = useSetAtom(uploadProgressAtom);
  const setInsufficientCreditsDialogOpen = useSetAtom(insufficientCreditsDialogOpenAtom);

  const { api, isConnected } = usePolkadotApi();

  const { polkadotAddress, walletManager } = useWalletAuth();

  if (!api || !isConnected || !polkadotAddress) {
    throw new Error("Blockchain connection not available");
  }

  if (!walletManager || !walletManager.polkadotPair) {
    throw new Error("Wallet keypair not available");
  }

  const handleChange = (id: string, field: "cid" | "name", value: string) => {
    setIpfsFilesToAdd((prev) =>
      prev.map((entry) =>
        entry.id === id ? { ...entry, [field]: value } : entry
      )
    );
  };

  const addEntry = () => {
    setIpfsFilesToAdd((prev) => [
      ...prev,
      { id: generateId(), cid: "", name: "" },
    ]);
  };

  const removeEntry = (id: string) => {
    setIpfsFilesToAdd((prev) => prev.filter((entry) => entry.id !== id));
  };

  const handleSubmit = () => {
    const trimmedEntries = ipfsFilesToAdd.map((entry) => ({
      ...entry,
      cid: entry.cid.trim(),
      name: entry.name.trim(),
    }));

    const validEntries = trimmedEntries.filter((entry) => {
      const cleanCid = entry.cid;
      const hasValidPrefix =
        cleanCid.startsWith("Qm") ||
        cleanCid.startsWith("bafk") ||
        cleanCid.startsWith("bafy");

      return cleanCid !== "" && entry.name !== "" && hasValidPrefix;
    });

    if (validEntries.length === 0) {
      toast.error(
        "Please provide at least one valid CID (Qm, bafk, bafy) and file name."
      );
      return;
    }

    // Close dialog immediately when submission starts
    reset();

    console.log("Submitting:", validEntries);
    setRquestState("uploading");
    setUploadProgress(0);

    uploadFileCids({
      files: validEntries.map((file) => ({
        filename: file.name,
        cid: file.cid,
      })),
      creditsChecker: getUserCredits,
      onUploadProgress: (value) => {
        setUploadProgress(value);
      },
    })
      .then(({ infoFile }) => {
        setRquestState("submitting");

        return submitFiles({
          infoFile,
          polkadotPair: walletManager.polkadotPair,
          api,
        });
      })
      .then(() => {
        setRquestState("idle");
        toast.success(validEntries ? `${validEntries.length} CID${validEntries.length > 1 ? "s" : ""} submitted successfully!` : "CIDs submitted successfully!");
        setUploadProgress(0);
        refetchUserFiles();

      })
      .catch((error) => {
        setRquestState("idle");
        if (error instanceof Error && error.message.includes("Insufficient Credits")) {
          setInsufficientCreditsDialogOpen(true);
        } else if (error instanceof Error) {
          toast.error(error.message);
        } else {
          toast.error("Oops an error occurred!");
        }
        setUploadProgress(0);
      });
  };

  const handleCancel = () => {
    setIpfsFilesToAdd([{ id: generateId(), cid: "", name: "" }]);
    reset();
  };

  return (
    <div className="text-grey-10">
      <P size="sm" className="mb-5 text-grey-50">
        Register existing IPFS files by providing thier CIDs and a names
      </P>

      <div className="flex max-h-[300px] pr-2 custom-scrollbar-thin overflow-y-auto flex-col gap-y-3">
        {ipfsFilesToAdd.map((entry) => (
          <div key={entry.id} className="flex items-end gap-x-2">
            <div className="flex gap-x-2">
              <div className="flex flex-col gap-y-0.5">
                <label className="text-sm font-medium">IPFS CID</label>
                <input
                  className="flex h-[36px] w-full bg-transparent text-grey-30 placeholder:!text-grey-70 font-medium rounded-[4px] border border-grey-80 px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="CID"
                  value={entry.cid}
                  onChange={(e) =>
                    handleChange(entry.id, "cid", e.target.value)
                  }
                />
              </div>
              <div className="flex flex-col gap-y-0.5">
                <label className="text-sm font-medium">File Name</label>
                <input
                  className="flex h-[36px] w-full bg-transparent text-grey-30 placeholder:!text-grey-70 font-medium rounded-[4px] border border-grey-80 px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="Name"
                  value={entry.name}
                  onChange={(e) =>
                    handleChange(entry.id, "name", e.target.value)
                  }
                />
              </div>
            </div>
            {ipfsFilesToAdd.length > 1 && (
              <button
                className="bg-grey-80 size-8 group flex items-center justify-center rounded-[3px] overflow-hidden"
                onClick={() => removeEntry(entry.id)}
              >
                <Trash2 className="size-5 text-grey-50 group-hover:text-red-500 duration-300" />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="space-x-2 mt-4">
        <Button size="sm" className="w-fit" onClick={addEntry}>
          <span className="flex items-center gap-x-2">
            <Plus className="size-5" /> Add More
          </span>
        </Button>
      </div>

      <div className="w-full flex flex-col mt-8 gap-y-2">
        <Button
          className="w-full"
          onClick={handleSubmit}
          disabled={ipfsFilesToAdd.some((entry) => entry.cid === "" || entry.name === "")}
        >
          Submit
        </Button>
        <Button className="w-full" variant="secondary" onClick={handleCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

export default AddCidFlow;

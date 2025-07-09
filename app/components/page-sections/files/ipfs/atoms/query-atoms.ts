import { atomWithMutation } from "jotai-tanstack-query";
import axios from "axios";
import { ApiPromise } from "@polkadot/api";
import { atom } from "jotai";
import { useUserCredits } from "@/lib/hooks/use-user-credits";

export type UploadFilesToIpfsAtomHandlers = {
  onUploadProgress?: (value: number) => void;
};

export const uploadProgressAtom = atom(0);
export const insufficientCreditsDialogOpenAtom = atom(false);

export const uploadFilesToIpfsAtom = atomWithMutation(() => {
  return {
    mutationKey: ["upload-files-to-ipfs"],
    mutationFn: async (props: {
      files: FileList;
      onUploadProgress?: (value: number) => void;
      creditsChecker: ReturnType<typeof useUserCredits>["refetch"];
    }) => {
      const { files, creditsChecker } = props;

      const fileArray = Array.from(files);
      const totalSize = fileArray.reduce((acc, file) => acc + file.size, 0);

      let uploadedBytesSoFar = 0;

      const uploadSingleFile = async (file: File) => {
        const credits = (await creditsChecker()).data;

        if (!credits || credits <= BigInt(0)) {
          throw new Error(
            "Insufficient Credits. Please add credits to your account."
          );
        }
        const formData = new FormData();
        formData.append("file", file, file.name);

        const response = await axios.post(
          "https://store.hippius.network/api/v0/add?recursive=true&wrap-with-directory=true",
          formData,
          {
            onUploadProgress: (progressEvent) => {
              const currentUploaded = progressEvent.loaded;

              // Update total uploaded bytes
              uploadedBytesSoFar += currentUploaded;
              const percent = (uploadedBytesSoFar / totalSize) * 100;

              props.onUploadProgress?.(Math.min(percent, 100));
            },
            headers: {
              "Content-Type": "multipart/form-data",
            },
          }
        );

        const data = response.data;

        const parsed: any = (data as string)
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));

        return {
          filename: file.name,
          cid: parsed[0].Hash as string,
        };
      };

      const uploadResults = await Promise.all(fileArray.map(uploadSingleFile));

      const jsonString = JSON.stringify(uploadResults);
      const blob = new Blob([jsonString], { type: "application/json" });
      const randomHash = Math.random().toString(36).substring(2, 10);
      const file = new File([blob], `${randomHash}.json`, {
        type: "application/json",
      });

      const infoFile = await uploadSingleFile(file);

      console.log(infoFile, "INFO FILE");
      console.log("uploadResults", uploadResults)

      return { files: uploadResults, infoFile };
    },
  };
});

export const submitFilesToBlockchainAtom = atomWithMutation(() => {
  return {
    mutationKey: ["submit-files-to-blockchain"],
    mutationFn: async (args: {
      infoFile: { filename: string; cid: string };
      polkadotPair: any;
      api: ApiPromise;
    }) => {
      const { infoFile, api, polkadotPair } = args;
      const { filename, cid } = infoFile;

      try {
        // Convert fileName and cid to bytes format
        const fileNameBytes = Array.from(new TextEncoder().encode(filename));
        const cidBytes = Array.from(new TextEncoder().encode(cid));

        // Create the file input object
        const fileInput = {
          fileHash: cidBytes,
          fileName: fileNameBytes,
        };

        // Create the extrinsic
        const tx = api.tx.marketplace.storageRequest([fileInput], null);

        await new Promise((resolve, reject) => {
          tx.signAndSend(polkadotPair, { nonce: -1 }, ({ status, events }) => {
            if (status.isInBlock || status.isFinalized) {
              // Get the appropriate block hash based on status type
              const blockHash = status.isInBlock
                ? status.asInBlock.toString()
                : status.isFinalized
                  ? status.asFinalized.toString()
                  : "unknown";

              // Check for events
              events.forEach(({ event }: { event: any }) => {
                if (api.events.system.ExtrinsicSuccess.is(event)) {
                  resolve(blockHash);
                  // Refresh the file list and storage stats after successful transaction
                  // fetchUserFiles();
                  // fetchTotalStorageSize();
                } else if (api.events.system.ExtrinsicFailed.is(event)) {
                  reject("Transaction failed");
                }
              });
            }
          });
        });
      } catch (error) {
        if (error instanceof Error) {
          throw Error;
        }

        if (typeof error === "string") {
          throw new Error(error);
        }

        throw new Error("Transaction failed");
      }

      // Sign and send the transaction using the in-memory keypair
    },
  };
});

export const uploadToIpfsAndSubmitToBlockcahinRequestStateAtom = atom<
  "uploading" | "submitting" | "idle"
>("idle");

export const uploadFileCIDsToIpfsAtom = atomWithMutation(() => {
  return {
    mutationKey: ["upload-file-cids-to-ipfs"],
    mutationFn: async (props: {
      files: { cid: string; filename: string }[];
      onUploadProgress?: (value: number) => void;
      creditsChecker: ReturnType<typeof useUserCredits>["refetch"];
    }) => {
      const { files, creditsChecker } = props;

      const uploadSingleFile = async (file: File) => {
        const credits = (await creditsChecker()).data;

        if (!credits || credits <= BigInt(0)) {
          throw new Error(
            "Insufficient Credits. Please add credits to your account."
          );
        }
        const formData = new FormData();
        formData.append("file", file, file.name);

        const response = await axios.post(
          "https://store.hippius.network/api/v0/add?recursive=true&wrap-with-directory=true",
          formData,
          {
            headers: {
              "Content-Type": "multipart/form-data",
            },
          }
        );

        props.onUploadProgress?.(100);

        const data = response.data;

        const parsed: any = (data as string)
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));

        return {
          filename: file.name,
          cid: parsed[0].Hash as string,
        };
      };

      const jsonString = JSON.stringify(files);
      const blob = new Blob([jsonString], { type: "application/json" });
      const randomHash = Math.random().toString(36).substring(2, 10);
      const file = new File([blob], `${randomHash}.json`, {
        type: "application/json",
      });

      const infoFile = await uploadSingleFile(file);

      // console.log(infoFile, "INFO FILE");

      return { files, infoFile };
    },
  };
});

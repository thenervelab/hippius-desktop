import { FC, useEffect, useState } from "react";
import FileDropzone from "./FileDropzone";
import { toast } from "sonner";
import {
  submitFilesToBlockchainAtom,
  uploadToIpfsAndSubmitToBlockcahinRequestStateAtom,
  uploadFileCIDsToIpfsAtom,
  uploadProgressAtom,
  insufficientCreditsDialogOpenAtom
} from "@/components/page-sections/files/ipfs/atoms/query-atoms";
import { useAtomValue, useSetAtom } from "jotai";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { generateId } from "@/lib/utils/generateId";
import { File } from "lucide-react";
import { Icons, CardButton } from "@/components/ui";
import useUserIpfsFiles from "@/lib/hooks/use-user-ipfs-files";
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { downloadDir } from '@tauri-apps/api/path';

type Entry = {
  id: string;
  cid: string;
  name: string;
};

const AddCSVFlow: FC<{ reset: () => void }> = ({ reset }) => {
  const [ipfsFilesToAdd, setIpfsFilesToAdd] = useState<Entry[]>([]);
  const [processedFiles, setProcessedFiles] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<File[] | null>(null);
  const {
    refetch: getUserCredits,
  } = useUserCredits();

  const { refetch: refetchUserFiles } = useUserIpfsFiles();
  const { mutateAsync: submitFiles, isPending: submittingFiles } = useAtomValue(
    submitFilesToBlockchainAtom
  );


  const { mutateAsync: uploadFileCids, isPending: uploadingFiles } =
    useAtomValue(uploadFileCIDsToIpfsAtom);

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

  useEffect(() => {
    if (!files || files.length === 0) return;

    // Filter out already processed files
    const newFiles = Array.from(files).filter(
      (file) => !processedFiles.has(file.name + "-" + file.size + "-" + file.lastModified)
    );

    if (newFiles.length === 0) {
      toast.info("All files have already been processed");
      setFiles(null);
      return;
    }

    let newEntries: Entry[] = [];
    let filesProcessed = 0;
    let totalValidEntries = 0;
    let totalInvalidEntries = 0;
    const invalidEntriesByFile: Record<string, string[]> = {};
    const newProcessedFileIds = new Set(processedFiles);

    const processNextFile = (index: number) => {
      if (index >= newFiles.length) {
        // All files processed
        if (newEntries.length > 0) {
          // Combine with existing entries
          setIpfsFilesToAdd((prevEntries) => [...prevEntries, ...newEntries]);
          setProcessedFiles(newProcessedFileIds);

          toast.success(`Added ${totalValidEntries} entries from ${filesProcessed} new files`);

          if (totalInvalidEntries > 0) {
            toast.warning(`Skipped ${totalInvalidEntries} invalid entries`);
            console.warn("Invalid entries by file:", invalidEntriesByFile);
          }
        } else {
          toast.error("No valid entries found in any of the new CSV files");
        }
        setFiles(null);
        return;
      }

      const file = newFiles[index];
      const fileId = file.name + "-" + file.size + "-" + file.lastModified;

      if (!file.name.toLowerCase().endsWith(".csv")) {
        toast.error(`Invalid file format: ${file.name}. Only CSV files are supported.`);
        processNextFile(index + 1);
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        if (!event.target || typeof event.target.result !== "string") {
          toast.error(`Failed to read CSV file: ${file.name}`);
          processNextFile(index + 1);
          return;
        }

        try {
          const entries: Entry[] = [];
          const invalidEntries: string[] = [];

          // Parse CSV content
          const content = event.target.result;
          // Handle different line endings (CRLF, LF)
          const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");

          if (lines.length === 0) {
            toast.warning(`CSV file is empty: ${file.name}`);
            processNextFile(index + 1);
            return;
          }

          // Check if the first line is a header
          const firstLine = lines[0].toLowerCase();
          const hasHeader = firstLine.includes("name") && firstLine.includes("cid");
          const startIndex = hasHeader ? 1 : 0;

          // Track successful and failed entries
          let validEntryCount = 0;
          let invalidEntryCount = 0;

          // Parse each line
          for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Split by comma, but handle quoted values properly
            let parts: string[] = [];
            if (line.includes('"')) {
              // Complex CSV parsing for quotes
              const regex = /(?:^|,)("(?:[^"]*(?:""[^"]*)*)"|[^,]*)/g;
              let match;
              while ((match = regex.exec(line)) !== null) {
                let value = match[1];
                if (value.startsWith('"') && value.endsWith('"')) {
                  value = value.substring(1, value.length - 1).replace(/""/g, '"');
                }
                parts.push(value);
              }
            } else {
              // Simple split for non-quoted values
              parts = line.split(",");
            }

            // Get name and CID from parts
            const name = parts[0]?.trim() || "";
            const cid = parts[1]?.trim() || "";

            // Validate CID format
            const isValidCid =
              cid.startsWith("Qm") ||
              cid.startsWith("bafk") ||
              cid.startsWith("bafy");

            // Validate name and CID
            if (!name || !isValidCid) {
              invalidEntryCount++;
              invalidEntries.push(`Line ${i + 1}: ${line}`);
              continue;
            }

            // Add valid entry
            entries.push({
              id: generateId(),
              name,
              cid,
            });
            validEntryCount++;
          }

          // Update counters
          filesProcessed++;
          totalValidEntries += validEntryCount;
          totalInvalidEntries += invalidEntryCount;

          if (invalidEntryCount > 0) {
            invalidEntriesByFile[file.name] = invalidEntries;
          }

          // Add entries from this file to the collection
          newEntries = [...newEntries, ...entries];
          newProcessedFileIds.add(fileId);

          // Process next file
          processNextFile(index + 1);

        } catch (error) {
          console.error(`Error parsing CSV file ${file.name}:`, error);
          toast.error(`Failed to parse CSV file: ${file.name}`);
          processNextFile(index + 1);
        }
      };

      reader.onerror = () => {
        toast.error(`Failed to read file: ${file.name}`);
        processNextFile(index + 1);
      };

      reader.readAsText(file);
    };

    // Start processing files
    processNextFile(0);
  }, [files, processedFiles]);

  // Add a reset function that clears all entries
  const handleReset = () => {
    setIpfsFilesToAdd([]);
    setProcessedFiles(new Set());
    reset();
  };

  const handleSubmit = () => {
    if (!ipfsFilesToAdd.length) {
      toast.error("No files to upload");
      return;
    }

    const validEntries = ipfsFilesToAdd.map((entry) => ({
      ...entry,
      cid: entry.cid.trim(),
      name: entry.name.trim(),
    }));

    // Close dialog immediately when submission starts
    reset();

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
        toast.success(`Successfully uploaded ${validEntries.length} files!`);
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
        setFiles(null);
        setUploadProgress(0);
      });
  };

  // Add a function to handle CSV template download
  const handleDownloadTemplate = async () => {
    try {
      const csvContent = `name,cid\nexample-file.txt,QmExampleCidForDemonstrationPurposes1234567890`;

      const downloadsPath = await downloadDir();

      const suggestedName = 'ipfs-csv-template.csv';

      const savePath = await save({
        defaultPath: `${downloadsPath}/${suggestedName}`,
        filters: [{
          name: 'CSV Files',
          extensions: ['csv']
        }]
      });

      if (!savePath) {
        return;
      }

      await writeTextFile(savePath, csvContent);

      // Show success message
      toast.success('CSV template downloaded successfully!');
    } catch (error) {
      console.error('Error downloading CSV template:', error);
      toast.error(`Failed to download CSV template: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="text-grey-10 w-full">
      <FileDropzone setFiles={setFiles} />
      {!!ipfsFilesToAdd.length && (
        <div className="flex flex-col mt-4 gap-2 max-h-[300px] overflow-y-auto custom-scrollbar-thin pr-1.5">
          <div className="flex justify-between items-center mb-1">
            <p className="text-sm font-medium text-grey-40">
              {ipfsFilesToAdd.length} file entries ready to submit
            </p>
            <button
              onClick={() => setIpfsFilesToAdd([])}
              className="text-xs text-red-500 hover:text-red-600"
            >
              Clear All
            </button>
          </div>

          {ipfsFilesToAdd.map(({ name, cid }, i) => (
            <div key={i} className="p-2 rounded-[8px] border font-medium">
              <div className="text-xs text-grey-50 flex truncate">
                <File className="size-3 min-w-3 translate-y-0.5 mr-1" />
                <div className="w-0 grow truncate">{name}</div>
              </div>
              <div className="break-words font-semibold mt-1 text-sm truncate">
                {cid}
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        className="flex items-center justify-center mt-4 hover:cursor-pointer underline text-grey-10"
        onClick={handleDownloadTemplate}
        role="button"
        tabIndex={0}
        aria-label="Download CSV template"
      >
        <Icons.DocumentDownload className="size-4" />
        <div className="text-sm font-semibold text-underline ml-2">Download CSV Template</div>
      </div>

      <div className="flex flex-col gap-y-2 mt-4">
        <CardButton
          disabled={!ipfsFilesToAdd.length || submittingFiles || uploadingFiles}
          className="w-full"
          onClick={handleSubmit}
        >
          Submit
        </CardButton>
        <CardButton className="w-full" variant="secondary" onClick={handleReset}>
          Cancel
        </CardButton>
      </div>
    </div>
  );
};

export default AddCSVFlow;

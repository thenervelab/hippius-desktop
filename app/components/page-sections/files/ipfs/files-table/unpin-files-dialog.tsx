import * as Dialog from "@radix-ui/react-dialog";
import { Copy, ChevronDown, ChevronUp } from "lucide-react";
import { Graphsheet } from "@/components/ui";
import * as Icons from "@/components/ui/icons";
import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { cn } from "@/lib/utils";
import InfoTooltip from "@/components/ui/info-tooltip";

// Constants for block time calculation
const BLOCKS_PER_EPOCH = 100; // Half epoch is 100 blocks
const AVG_BLOCK_TIME_MS = 6000;

// UI constants remain the same
const COLLAPSED_HEIGHT = 64;
const EXPANDED_HEIGHT = 460;
const BODY_MAX_HEIGHT = EXPANDED_HEIGHT - COLLAPSED_HEIGHT;

export type FileDetail = {
  filename: string;
  cid: string;
  createdAt?: number;
};

interface FileDetailsDialogProps {
  open: boolean;
  unpinnedFiles: FileDetail[];
}

type EpochProgress = {
  percentage: number;
  timeRemaining: { hours: number; minutes: number; total: number };
};

const FileDetailsDialog: React.FC<FileDetailsDialogProps> = ({
  open,
  unpinnedFiles,
}) => {
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const { api, isConnected } = usePolkadotApi();
  const [currentBlockNumber, setCurrentBlockNumber] = useState<number>(0);
  const [currentValidatorBlock, setCurrentValidatorBlock] = useState<number>(0);
  const [fileProgress, setFileProgress] = useState<Record<string, EpochProgress>>({});
  const [isExpanded, setIsExpanded] = useState(false);

  // subscribe to new blocks and fetch current validator block
  useEffect(() => {
    if (!api || !isConnected || !open) return;

    let unsubBlocks: () => void;

    // Subscribe to new blocks
    api.rpc.chain
      .subscribeNewHeads(header => {
        setCurrentBlockNumber(header.number.toNumber());
      })
      .then(u => (unsubBlocks = u));

    // Fetch current epoch validator block
    const fetchCurrentValidator = async () => {
      try {
        // Use currentEpochValidator() as specified
        const validatorData = await api.query.ipfsPallet.currentEpochValidator();

        // Parse the Option<(AccountId32,u64)> response
        if (validatorData.isSome) {
          // Extract the block number from the tuple
          const [_, blockNumber] = validatorData.unwrap();
          setCurrentValidatorBlock(blockNumber.toNumber());
        } else {
          console.warn("No current epoch validator found");
        }

        // Set up polling to periodically refresh validator block
        if (api && isConnected) {
          const updatedValidatorData = await api.query.ipfsPallet.currentEpochValidator();
          if (updatedValidatorData.isSome) {
            const [_, blockNumber] = updatedValidatorData.unwrap();
            setCurrentValidatorBlock(blockNumber.toNumber());
          }
        }

      } catch (error) {
        console.error("Error fetching validator block:", error);
      }
    };

    const cleanupInterval = fetchCurrentValidator();

    return () => {
      unsubBlocks?.();
      cleanupInterval?.then(cleanup => cleanup?.());
    };
  }, [api, isConnected, open]);

  // calculate progress based on current validator block
  useEffect(() => {
    if (!currentBlockNumber || !currentValidatorBlock || !unpinnedFiles.length) return;

    const progressMap: Record<string, EpochProgress> = {};

    // Calculate the remaining blocks in the current half-epoch
    const nextEpochPlusOneBlockForEstimate = currentValidatorBlock + (2 * BLOCKS_PER_EPOCH);
    const blocksRemaining = Math.max(0, nextEpochPlusOneBlockForEstimate - currentBlockNumber);

    // Calculate progress percentage based on total blocks
    const totalEpochBlocks = BLOCKS_PER_EPOCH * 2; // 200 blocks total
    const blocksPassed = totalEpochBlocks - blocksRemaining;
    const percentage = Math.min(99, Math.floor((blocksPassed / totalEpochBlocks) * 100));

    // Calculate time remaining
    const msRemaining = blocksRemaining * AVG_BLOCK_TIME_MS;
    const hoursRemaining = Math.floor(msRemaining / 3_600_000);
    const minutesRemaining = Math.floor((msRemaining % 3_600_000) / 60_000);

    // Debug log to see if we're hitting low minute values
    setDebugTimeInfo(`Blocks: ${blocksRemaining}, Time: ${hoursRemaining}h ${minutesRemaining}m`);

    // Create the progress object with the calculated values
    const progress = {
      percentage,
      timeRemaining: {
        hours: hoursRemaining,
        minutes: minutesRemaining,
        total: msRemaining
      }
    };

    // Apply the same progress to all files
    unpinnedFiles.forEach(file => {
      if (file.cid) {
        progressMap[file.cid] = progress;
      }
    });

    setFileProgress(progressMap);
  }, [currentBlockNumber, currentValidatorBlock, unpinnedFiles]);

  // fade on scroll - unchanged
  useEffect(() => {
    const fileList = fileListRef.current;
    if (!fileList || !isExpanded) return;
    const handleScroll = () => {
      const { clientHeight } = fileList;
      const topFade = 20;
      const bottomFade = 20;
      fileList
        .querySelectorAll<HTMLElement>('[data-file-item]')
        .forEach(el => {
          const { top, height } = el.getBoundingClientRect();
          const offsetTop = top - fileList.getBoundingClientRect().top;
          const offsetBottom = offsetTop + height;
          if (offsetTop < topFade) {
            el.style.opacity = `${Math.max(0.3, offsetTop / topFade)}`;
          } else if (offsetBottom > clientHeight - bottomFade) {
            el.style.opacity = `${Math.max(0.3, (clientHeight - offsetTop) / bottomFade)}`;
          } else {
            el.style.opacity = '1';
          }
        });
    };
    fileList.addEventListener('scroll', handleScroll);
    return () => fileList.removeEventListener('scroll', handleScroll);
  }, [isExpanded]);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text)
      .then(() => toast('CID copied to clipboard'))
      .catch(() => toast('Failed to copy'));
  }, []);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(v => !v);
  }, []);

  if (!unpinnedFiles?.length) return null;

  // find max remaining - this will be the same for all files now
  const { hours: maxH, minutes: maxM } = Object.values(fileProgress).length > 0
    ? Object.values(fileProgress)[0].timeRemaining
    : { hours: 0, minutes: 0, total: 0 };

  const timeLeftText = `~ ${maxH > 0 ? `${maxH} hrs ` : ''}${maxM} mins left`;
  const totalChunks = unpinnedFiles.length;

  // Calculate the highest progress percentage for the circle
  const highestPercentage = Object.values(fileProgress).length > 0
    ? Object.values(fileProgress)[0].percentage || 0
    : 0;

  return (
    <Dialog.Root open={open} modal={false}>
      <Dialog.Portal>
        <Dialog.Content
          ref={dialogContentRef}
          onClick={e => e.stopPropagation()}
          className={cn(
            "fixed right-4 sm:right-12 bottom-20 sm:bottom-7 z-[2] outline-none shadow-menu rounded-[8px] transition-all duration-300 ease-in-out",
            isExpanded ? "w-[378px]" : "w-16 sm:w-[220px]"
          )}
        >
          {/* Header */}
          <div
            className={cn(
              "shadow-menu bg-grey-100 border border-grey-80 cursor-pointer hover:bg-grey-90 transition-all duration-300 ease-in-out",
              isExpanded ? "rounded-t-[8px] w-[378px]" : "rounded-[8px] w-16 sm:w-[220px]"
            )}
            onClick={toggleExpanded}
          >
            <div className={cn(
              "relative flex items-center gap-3 justify-between transition-all duration-300 ease-in-out",
              isExpanded ? "p-4" : "p-2"
            )}>
              <Graphsheet
                majorCell={{ lineColor: [213, 224, 248, 1], lineWidth: 1, cellDim: 100 }}
                minorCell={{ lineColor: [213, 224, 248, 1], lineWidth: 1, cellDim: 20 }}
                className={cn(
                  "absolute w-full h-full opacity-50 inset-0 transition-opacity duration-300",
                  isExpanded ? "opacity-50" : "opacity-0 sm:opacity-0"
                )}
              />

              <div className="flex items-center">
                <div className={cn(
                  "relative transition-all duration-300",
                  isExpanded ? "opacity-0 absolute w-0 overflow-hidden" : "opacity-100 relative size-12"
                )}>
                  {/* Circular progress indicator - only visible when collapsed */}
                  <svg className="absolute inset-0 w-full h-full -rotate-90 z-10" viewBox="0 0 48 48">
                    <circle
                      cx="24" cy="24" r="22"
                      className="fill-none stroke-[4] stroke-[#e8eeff]"
                    />
                    <circle
                      cx="24" cy="24" r="22"
                      className="fill-none stroke-[4] stroke-[#4171e0]"
                      strokeLinecap="round"
                      strokeDasharray={`${highestPercentage * 1.38} 138`}
                    />
                  </svg>

                  {/* Icon wrapper */}
                  <div className="absolute inset-0 size-12 flex items-center justify-center">
                    <AbstractIconWrapper className="size-10 flex items-center justify-center rounded-[50%]" iconGridClassName="rounded-[50%]">
                      <Icons.SendSquare className="size-6 relative text-primary-50" />
                    </AbstractIconWrapper>
                  </div>
                </div>

                {/* Title - only visible when expanded */}
                <Dialog.Title
                  className={cn(
                    "flex items-center transition-all duration-300",
                    isExpanded ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-4 absolute"
                  )}
                >
                  <span className="text-base font-medium text-grey-10">Upload Queue</span>
                  <InfoTooltip className="ml-2">
                    Your files are now recorded on‐chain and are being pinned to IPFS. Pinning can take a few minutes. Thank you for your patience!
                  </InfoTooltip>
                </Dialog.Title>
              </div>

              <div className={cn(
                "flex items-center whitespace-nowrap transition-all duration-300 ease-in-out",
                isExpanded ? "opacity-100" : "opacity-0 sm:opacity-100"
              )}>
                <span className="text-sm text-grey-40 mr-2">{timeLeftText}</span>
                <div className="transition-transform duration-300 ease-in-out">
                  {isExpanded ? (
                    <ChevronDown className="h-5 w-5 text-grey-40" />
                  ) : (
                    <ChevronUp className="h-5 w-5 text-grey-40" />
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Animated body */}
          <div
            className="overflow-hidden transition-[max-height,opacity] duration-300 ease-in-out"
            style={{
              maxHeight: isExpanded ? `${BODY_MAX_HEIGHT}px` : '0px',
              opacity: isExpanded ? 1 : 0
            }}
          >
            <div className="bg-grey-100 border border-grey-80 rounded-b-[8px] w-[378px] overflow-hidden">
              {/* Status banner */}
              <div className="flex w-full mt-4 ml-4">
                <div className="w-fit px-2 py-0.5 bg-primary-100/40 border border-primary-80 rounded">
                  <div className="text-sm text-primary-40">
                    0 of {totalChunks} files uploaded
                  </div>
                </div>
              </div>

              {/* File list */}
              <div ref={fileListRef} className="max-h-[320px] overflow-y-auto p-4">
                {unpinnedFiles.map((detail, index) => {
                  const prog = fileProgress[detail.cid] || {
                    percentage: 0,
                    timeRemaining: { hours: 0, minutes: 0, total: 0 }
                  };
                  const isCompleted = false;
                  return (
                    <div
                      key={`${detail.cid}-${index}`}
                      className="flex items-center justify-between mb-4 last:mb-0 transition-opacity duration-200"
                      data-file-item
                    >
                      <div className="flex items-center gap-2">
                        <AbstractIconWrapper className="size-8 flex items-center justify-center">
                          <Icons.BoxSimple2 className="size-5 relative text-primary-50" />
                        </AbstractIconWrapper>
                        <div className="flex flex-col justify-center">
                          <div className="text-sm font-medium text-grey-10 truncate flex items-center gap-2">
                            <span>
                              {detail.filename.length > 16
                                ? `${detail.filename.slice(0, 7)}...${detail.filename.slice(-7)}`
                                : detail.filename}
                            </span>
                          </div>
                          <div className="flex items-center mt-1">
                            <div className="text-xs text-grey-70">
                              <div className="flex items-center gap-1">
                                <span>CID: </span>
                                <span className="text-grey-70 font-medium truncate">
                                  {detail.cid.slice(0, 5)}...{detail.cid.slice(-5)}
                                </span>
                              </div>
                            </div>
                            <button
                              className="ml-2 text-grey-70 hover:text-primary-60 flex-shrink-0"
                              onClick={e => { e.stopPropagation(); copyToClipboard(detail.cid); }}
                              aria-label="Copy CID"
                            >
                              <Copy className="size-4 text-grey-70" />
                            </button>
                          </div>
                        </div>
                      </div>
                      {isCompleted ? (
                        <div className="flex items-center">
                          <Icons.TickCircle className="w-5 h-5 text-success-50" />
                          <span className="text-sm ml-1 text-success-50">
                            Upload Successful
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center">
                          <div className="text-[10px] text-grey-60 font-medium mr-1">
                            ~
                            {prog.timeRemaining.hours > 0 && (
                              <>{prog.timeRemaining.hours} hours{prog.timeRemaining.hours !== 1 ? "s" : ""} </>
                            )}
                            {prog.timeRemaining.minutes} minutes left
                          </div>
                          <div className="relative size-10 flex items-center justify-center">
                            <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                              <circle cx="50" cy="50" r="40" className="fill-none stroke-[8] stroke-grey-80/80" />
                              <circle cx="50" cy="50" r="40" className="fill-none stroke-[8] stroke-success-50" strokeLinecap="round" strokeDasharray={`${prog.percentage * 2.51} 251`} />
                            </svg>
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="text-[10px] font-medium text-success-40">{prog.percentage}%</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default FileDetailsDialog;

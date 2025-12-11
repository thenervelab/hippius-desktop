import React from "react";
import { FormattedTimestamp, Icons } from "@/components/ui";
import * as TableModule from "@/components/ui/alt-table";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { formatBytesFromBigInt } from "@/lib/utils/formatBytes";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getFileIcon } from "@/app/lib/utils/fileTypeUtils";
import { cn } from "@/app/lib/utils";
import { HIPPIUS_EXPLORER_CONFIG } from "@/app/lib/config";
import { useNodeLocations } from "@/app/lib/hooks/api/useNodeLocations";
import { useFileNodes } from "@/app/lib/hooks/api/useFileNodes";
import { useIsPrivateView } from "@/app/lib/utils/viewUtils";

interface DetailRowProps {
  label: string;
  children: React.ReactNode;
  lastChild?: boolean;
}

const DetailRow: React.FC<DetailRowProps> = ({
  label,
  children,
  lastChild
}) => (
  <div
    className={cn("pb-4 border-b border-grey-80", { "border-b-0": lastChild })}
  >
    <div className="text-sm font-medium text-grey-70 mb-2">{label}</div>
    <div className="text-base leading-[22px] font-medium text-grey-20">
      {children}
    </div>
  </div>
);

interface FileLocationItemProps {
  location: string;
  lastChild?: boolean;
}

const FileLocationItem: React.FC<FileLocationItemProps> = ({
  location,
  lastChild
}) => (
  <div className="inline-flex items-center text-base text-grey-20">
    {location}
    {!lastChild && (
      <span className="mx-2 h-1 w-1 bg-grey-80 rounded-full"></span>
    )}
  </div>
);

interface NodeItemProps {
  nodeId: string;
}

const NodeItem: React.FC<NodeItemProps> = ({ nodeId }) => (
  <div className="inline-flex items-center gap-1 hover:bg-grey-90 border border-grey-80 rounded px-2 py-1 text-xs text-grey-10 mr-2 mb-2">
    <TableModule.CopyableCell
      title="Copy Node ID"
      toastMessage="Node ID Copied Successfully!"
      copyAbleText={nodeId}
      link={`${HIPPIUS_EXPLORER_CONFIG.baseUrl}/nodes/${nodeId}`}
      linkClass="group-hover:underline group-hover:text-primary-50 hover:underline"
      forSmallScreen
      className="max-sm:[200px] max-w-[400px] h-full"
    />
  </div>
);

interface FileDetailsDialogContentProps {
  file?: FormattedUserFile;
}

const FileDetailsDialogContent: React.FC<FileDetailsDialogContentProps> = ({
  file
}) => {
  const isPrivateView = useIsPrivateView();

  // Get CID for API calls
  const decodedCid = file ? decodeHexCid(file.cid) : null;
  const isCidValid = decodedCid && decodedCid !== "pending";

  // Fetch nodes for the file CID
  const { data: nodesData, isLoading: isNodesLoading, error: nodesError } = useFileNodes(isCidValid ? decodedCid : null);

  // Extract node IDs from the response
  const minerIds = nodesData?.nodes || [];

  // Fetch locations for the nodes
  const { uniqueLocations, isLoading: isLocationsLoading } = useNodeLocations(minerIds);

  if (!file) return null;

  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  // decodedCid is already defined above
  const { icon: Icon, color } = getFileIcon(
    fileType ?? undefined,
    !!file.isFolder
  );

  // Format file size
  const fileSize = file.size
    ? formatBytesFromBigInt(BigInt(file.size))
    : "Unknown";

  // Determine what to show for locations
  const getLocationsDisplay = () => {
    if (!isCidValid) {
      return ["No CID available"];
    }
    if (isNodesLoading || isLocationsLoading) {
      return ["Loading locations..."];
    }
    if (nodesError) {
      return ["Failed to load node data"];
    }
    if (minerIds.length === 0) {
      return ["No nodes available"];
    }
    if (uniqueLocations.length === 0) {
      return ["No location data available"];
    }
    return uniqueLocations;
  };

  const locationsToShow = getLocationsDisplay();

  const handleViewOnExplorer = async () => {
    try {
      if (!decodedCid) {
        console.error("No CID available");
        return;
      }
      await openUrl(`http://hipstats.com/cid-tracker/${decodedCid}`);
    } catch (error) {
      console.error("Failed to open Explorer:", error);
    }
  };

  return (
    <div className="flex justify-between flex-col gap-2 h-full">
      <div className="flex flex-col gap-3">
        <DetailRow label="File Name">{file.name}</DetailRow>

        <DetailRow label="File Type">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Icon className={cn("size-5", color)} />
              {file.isFolder
                ? "Folder"
                : fileType
                  ? fileType.charAt(0).toUpperCase() + fileType.slice(1)
                  : ""}
            </div>
            {!isPrivateView && file.isErasureCoded && (
              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-white text-primary-60 border border-primary-50 shadow-sm">
                <Icons.ShieldSecurity className="size-3 mr-1.5 text-primary-50" />
                Erasure Coded
              </span>
            )}
          </div>
        </DetailRow>

        <DetailRow label="Date Uploaded">
          {file.createdAt === 0 ? "Unknown" : <FormattedTimestamp timestamp={file.createdAt} />}
        </DetailRow>

        <DetailRow label="File Size">
          <div className="flex items-center gap-2">
            <Icons.File className="size-4 text-grey-70" />
            <span>{fileSize}</span>
          </div>
        </DetailRow>

        <DetailRow label="CID">
          {isCidValid ? (
            <>
              <TableModule.CopyableCell
                title="Copy CID"
                toastMessage="CID Copied Successfully!"
                copyAbleText={decodedCid || ""}
                isTable={true}
                className="max-sm:[200px] max-w-[400px] h-full"
              />
              <div
                className="p-0 h-auto text-primary-50 text-base flex items-center gap-1 hover:underline cursor-pointer"
                onClick={handleViewOnExplorer}
              >
                View CID Tracker
                <Icons.SendSquare2 className="size-5 text-primary-50" />
              </div>
            </>
          ) : (
            <span className="text-grey-50">No CID available</span>
          )}
        </DetailRow>

        <DetailRow label="File Location">
          <div className="flex flex-wrap">
            {locationsToShow.map((location, idx) => (
              <FileLocationItem
                key={idx}
                location={location}
                lastChild={idx === locationsToShow.length - 1}
              />
            ))}
          </div>
          {isCidValid && (
            <div
              className="p-0 h-auto text-primary-50 text-base flex items-center gap-1 hover:underline cursor-pointer"
              onClick={handleViewOnExplorer}
            >
              View on Explorer
              <Icons.SendSquare2 className="size-5 text-primary-50" />
            </div>
          )}
        </DetailRow>

        <DetailRow label="Nodes" lastChild>
          <div className="flex flex-wrap">
            {isCidValid ? (
              minerIds.length > 0 ? (
                minerIds.map((nodeId, idx) => (
                  <NodeItem key={idx} nodeId={nodeId} />
                ))
              ) : (
                <span className="text-grey-50">
                  {isNodesLoading ? "Loading nodes..." : "No nodes available"}
                </span>
              )
            ) : (
              <span className="text-grey-50">
                No CID available
              </span>
            )}
          </div>
          {isCidValid && (
            <div
              className="p-0 h-auto text-primary-50 text-base flex items-center gap-1 hover:underline cursor-pointer"
              onClick={handleViewOnExplorer}
            >
              View on Explorer
              <Icons.SendSquare2 className="size-5 text-primary-50" />
            </div>
          )}
        </DetailRow>
      </div>
    </div>
  );
};

export default FileDetailsDialogContent;

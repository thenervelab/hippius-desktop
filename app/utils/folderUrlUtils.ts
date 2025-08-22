import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { buildFolderPath } from "./folderPathUtils";

type ParamGetter = (name: string, defaultValue?: string) => string;

/**
 * Generates a folder URL based on a file and current path parameters
 * 
 * @param file The folder file object
 * @param getParam Function to get URL parameters
 * @returns An object containing the URL string and the query parameters
 */
export function generateFolderUrl(file: FormattedUserIpfsFile, getParam: ParamGetter) {
    // Get current path information for folder navigation
    const folderActualName = file.isFolder ? file.actualFileName || "" : "";
    const mainFolderCid = getParam("mainFolderCid", "");
    const mainFolderActualName = getParam("mainFolderActualName", folderActualName);
    const subFolderPath = getParam("subFolderPath", "");
    const effectiveMainFolderCid = mainFolderCid || file.cid;
    const effectiveMainFolderActualName = mainFolderActualName || folderActualName;

    // Build the folder path for navigation
    const { mainFolderActualName: newMainFolder, subFolderPath: newSubFolderPath } = buildFolderPath(
        folderActualName,
        effectiveMainFolderCid,
        effectiveMainFolderActualName,
        subFolderPath
    );

    const queryParams = {
        mainFolderCid: effectiveMainFolderCid ?? "",
        folderCid: decodeHexCid(file.cid) ?? "",
        folderName: file.name ?? "",
        folderActualName: file.actualFileName ?? "",
        mainFolderActualName: newMainFolder ?? "",
        subFolderPath: newSubFolderPath ?? "",
        folderSource: file.source || ""
    };

    const query = new URLSearchParams(queryParams).toString();
    const url = `/files?${query}`;

    return {
        url,
        queryParams,
        query
    };
}

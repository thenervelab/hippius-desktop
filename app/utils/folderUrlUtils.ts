import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { buildFolderPath } from "./folderPathUtils";

type ParamGetter = (name: string, defaultValue?: string) => string;

/**
 * Generates a folder URL based on a file and current path parameters.
 *
 * `parentSubFolderPath` overrides the URL-derived `subFolderPath` and is
 * used when the caller knows the file's parent path from runtime context
 * rather than the current URL — e.g. a folder row inside an inline-expanded
 * subtree, where the URL still reflects an ancestor several levels above.
 * Without it, deep clicks build URLs that skip intermediate segments,
 * which breaks both the breadcrumb and the nested listing query.
 *
 * @param file The folder file object
 * @param getParam Function to get URL parameters
 * @param parentSubFolderPath Optional parent path inside the sync drive
 *   (e.g. "MyDrive/Photos/2024"). When provided, its first segment is
 *   also used as `mainFolderActualName`, replacing the URL value.
 * @returns An object containing the URL string and the query parameters
 */
export function generateFolderUrl(
    file: FormattedUserFile,
    getParam: ParamGetter,
    parentSubFolderPath?: string,
) {
    // Get current path information for folder navigation
    const folderActualName = file.isFolder ? file.actualFileName || "" : "";
    const mainReqHash = file.mainReqHash
    const mainFolderCid = getParam("mainFolderCid", "");

    const trimmedParentPath = parentSubFolderPath?.replace(/^\/+|\/+$/g, "") ?? "";
    const parentMainFolder = trimmedParentPath
        ? trimmedParentPath.split("/")[0] ?? ""
        : "";

    const mainFolderActualName = trimmedParentPath
        ? parentMainFolder
        : getParam("mainFolderActualName", folderActualName);
    const subFolderPath = trimmedParentPath
        ? trimmedParentPath
        : getParam("subFolderPath", "");
    const effectiveMainFolderCid = mainFolderCid || file.arionHash;
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
        folderCid: file.arionHash ?? "",
        folderName: file.name ?? "",
        folderActualName: file.actualFileName ?? "",
        mainFolderActualName: newMainFolder ?? "",
        subFolderPath: newSubFolderPath ?? "",
        folderSource: file.source || "",
        mainReqHash: mainReqHash
    };

    const query = new URLSearchParams(queryParams).toString();
    const url = `/files?${query}`;

    return {
        url,
        queryParams,
        query
    };
}

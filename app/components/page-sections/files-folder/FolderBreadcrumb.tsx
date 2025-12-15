"use client";

import { FC } from "react";
import Link from "next/link";
import { Icons } from "@/components/ui";

interface BreadcrumbSegment {
  name: string;
  path: string;
}

interface FolderBreadcrumbProps {
  mainFolderActualName: string | undefined;
  subFolderPath: string | undefined;
  folderSource: string | null;
  mainReqHash: string | null;
}

const truncateText = (text: string, maxLength: number = 20): string => {
  if (text.length <= maxLength) return text;
  const start = text.substring(0, Math.floor(maxLength * 0.4));
  const end = text.substring(text.length - Math.floor(maxLength * 0.4));
  return `${start}...${end}`;
};

function getBreadcrumbSegments(
  mainFolder: string | undefined,
  subFolderPath: string | undefined
): BreadcrumbSegment[] {
  const breadcrumbs: BreadcrumbSegment[] = [];

  if (!mainFolder) return breadcrumbs;

  // Add main folder as first breadcrumb
  breadcrumbs.push({
    name: mainFolder,
    path: mainFolder,
  });

  if (subFolderPath) {
    // Remove the main folder from subFolderPath if it starts with it
    let normalizedSubPath = subFolderPath;
    if (subFolderPath.startsWith(mainFolder + "/")) {
      normalizedSubPath = subFolderPath.substring(mainFolder.length + 1);
    } else if (subFolderPath === mainFolder) {
      // If subFolderPath is the same as mainFolder, we don't need to add anything
      return breadcrumbs;
    }

    const segments = normalizedSubPath.split("/").filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const subPath = segments.slice(0, i + 1).join("/");
      breadcrumbs.push({
        name: segments[i],
        path: `${mainFolder}/${subPath}`,
      });
    }
  }

  return breadcrumbs;
}

const FolderBreadcrumb: FC<FolderBreadcrumbProps> = ({
  mainFolderActualName,
  subFolderPath,
  folderSource,
  mainReqHash,
}) => {
  const breadcrumbSegments = getBreadcrumbSegments(
    mainFolderActualName,
    subFolderPath
  );

  if (breadcrumbSegments.length === 0) return null;

  const buildFolderUrl = (
    segment: BreadcrumbSegment,
    index: number,
    isLast: boolean
  ) => {
    if (isLast) return "#";

    // For navigation, we need to properly set the mainFolderActualName and subFolderPath
    // based on which breadcrumb segment was clicked
    const params = new URLSearchParams();

    // For the first breadcrumb (main folder), don't set folderCid as we're going back
    // For subsequent breadcrumbs, we're navigating to a subfolder
    const pathParts = segment.path.split("/");
    const mainFolder = pathParts[0];

    // If it's the main folder (first segment)
    if (index === 0) {
      params.set("folderName", mainFolder);
      params.set("folderActualName", mainFolder);
      params.set("mainFolderActualName", mainFolder);
      // subFolderPath should contain mainFolderActualName at the start
      params.set("subFolderPath", mainFolder);
    } else {
      // For subfolders, set the path up to this segment
      // folderName and folderActualName should always be the same
      params.set("folderName", segment.name);
      params.set("folderActualName", segment.name);
      params.set("mainFolderActualName", mainFolder);
      // subFolderPath should contain mainFolderActualName at the start
      params.set("subFolderPath", segment.path);
    }

    if (folderSource) {
      params.set("folderSource", folderSource);
    }
    if (mainReqHash) {
      params.set("mainReqHash", mainReqHash);
    }

    return `/files?${params.toString()}`;
  };

  return (
    <div className="flex flex-wrap items-center gap-2 font-medium text-base">
      {breadcrumbSegments.map((segment, index) => {
        const isLast = index === breadcrumbSegments.length - 1;
        return (
          <div key={segment.path} className="flex items-center gap-2">
            {index > 0 && <Icons.ArrowRight className="size-4 text-grey-70" />}
            {isLast ? (
              <span className="text-primary-50" title={segment.name}>
                {truncateText(segment.name)}
              </span>
            ) : (
              <Link href={buildFolderUrl(segment, index, isLast)}>
                <span
                  className="text-grey-60 hover:text-primary-50 cursor-pointer"
                  title={segment.name}
                >
                  {truncateText(segment.name)}
                </span>
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default FolderBreadcrumb;

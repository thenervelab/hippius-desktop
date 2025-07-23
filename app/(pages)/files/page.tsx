"use client";

import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import FolderView from "@/app/components/page-sections/files-folder";
import { Files } from "@/components/page-sections";
import { useSearchParams } from "next/navigation";
import { FC } from "react";

const FilesPage: FC = () => {
    const params = useSearchParams();
    const folderCid = params.get("folderCid");
    const folderName = params.get("folderName") || "Folder";
    console.log("Folder Name:", folderName);

    if (folderCid) {
        return (
            <DashboardTitleWrapper mainText={`Your Files - ${folderName}`}>
                <FolderView folderCid={folderCid} folderName={folderName} />
            </DashboardTitleWrapper>
        );
    }
    return <Files />;
};

export default FilesPage;

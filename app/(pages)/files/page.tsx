"use client";

import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import FolderView from "@/app/components/page-sections/files-folder";
import { Files } from "@/components/page-sections";
import { useSearchParams } from "next/navigation";
import { FC } from "react";

const FilesPage: FC = () => {
    const params = useSearchParams();
    const folderCid = params.get("folderCid");

    if (folderCid) {
        return (
            <DashboardTitleWrapper mainText="Your Files(Folder)">
                <FolderView folderCid={folderCid} />
            </DashboardTitleWrapper>
        );
    }
    return <Files />;
};

export default FilesPage;

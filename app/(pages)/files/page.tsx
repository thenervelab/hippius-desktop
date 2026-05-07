"use client";

import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import FolderView from "@/app/components/page-sections/files-folder";
import { Drive } from "@/components/page-sections";
import { FC } from "react";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";

const FilesPage: FC = () => {
    const { getParam } = useUrlParams();

    const folderCid = getParam("folderCid");
    const folderName = getParam("folderName", "");
    const folderActualName = getParam("folderActualName", "");
    const mainFolderActualName = getParam("mainFolderActualName", "");
    const subFolderPath = getParam("subFolderPath");

    if (folderName) {
        return (
            <DashboardTitleWrapper mainText={`My Drive - ${folderName}`}>
                <FolderView
                    folderCid={folderCid}
                    folderName={folderName}
                    folderActualName={folderActualName}
                    mainFolderActualName={mainFolderActualName}
                    subFolderPath={subFolderPath}
                />
            </DashboardTitleWrapper>
        );
    }
    return <Drive />;
};

export default FilesPage;

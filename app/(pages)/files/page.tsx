"use client";

import FolderView from "@/app/components/page-sections/files-folder";
import { Files } from "@/components/page-sections";
import { useSearchParams } from "next/navigation";
import { FC } from "react";

const FilesPage: FC = () => {
    const params = useSearchParams();
    const folderCid = params.get("folderCid");

    if (folderCid) {
        return <FolderView folderCid={folderCid} />;
    }
    return <Files />;
};

export default FilesPage;

"use client";

import { FC, useState } from "react";
import { useParams } from "next/navigation";

import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import * as Icons from "@/components/ui/icons";
import SearchInput from "@/components/ui/SearchInput";
import RefreshButton from "@/components/ui/refresh-button";
import { P } from "@/components/ui/typography";

import { useUserIpfsDirectoryFiles } from "@/hooks/useUserIpfsDirectoryFiles";
import DirectoryTable from "./directory-table";
import { ArrowRight } from "@/components/ui/icons";
import GoBackButton from "../ui/go-back-button";

const IpfsDirectoryPage: FC = () => {
  const { cid } = useParams() as { cid: string };
  const [filter, setFilter] = useState("");

  const { data, isLoading, isRefetching, refetch, error } =
    useUserIpfsDirectoryFiles(cid);

  const chunks = data?.chunks.filter((c) =>
    c.filename.toLowerCase().includes(filter.toLowerCase())
  );

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };

  return (
    <div className="w-full">
      <div className="flex justify-between items-center">

        {/* Back */}
        <GoBackButton href="/dashboard/storage/ipfs" />

        {/* Search + Refresh */}
        <div className="flex items-center gap-4">
          <SearchInput
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search for a file"
            className="h-9"
          />
          <RefreshButton refetching={isRefetching} onClick={() => refetch()} />
        </div>

      </div>



      {/* Breadcrumb + Title + tags */}
      <div className="flex flex-wrap items-center gap-2 my-4">
        <div className="flex items-center gap-x-2">
          <AbstractIconWrapper className="size-6 flex items-center justify-center">
            <Icons.BoxSimple2 className="size-4 relative text-primary-50" />
          </AbstractIconWrapper>
          <P size="sm">Your Storage</P>
        </div>
        <ArrowRight className="size-4 text-primary-50" />
        <Icons.Directory className="size-4 text-primary-40" />

        <P size="sm">{data?.meta.originalName || "Folder"}</P>
      </div>


      <div className="flex flex-wrap items-center gap-2 mt-4">
        <P size="md">{data?.meta.originalName || "Folder"}</P>

        <span className="flex items-center bg-grey-90 border border-grey-80 px-2 py-1 rounded text-sm font-medium">
          <Icons.Directory className="size-4 text-grey-10 mr-2" />Chunk – {data?.meta.totalChunks} Chunks
        </span>
        <span className="h-6 w-0.5 bg-grey-80"></span>
        <span className="inline-block bg-grey-90 border border-grey-80 px-2 py-1 rounded text-sm font-medium">
          K: {data?.meta.k} – M: {data?.meta.m}
        </span>
        <span className="text-grey-50 text-sm font-medium">
          {data?.meta.uploadedAt ? "Uploaded " + formatDate(data?.meta.uploadedAt) : ""}
        </span>
      </div>

      {/* Table */}
      <DirectoryTable
        data={chunks || []}
        isLoading={isLoading}
        isRefetching={isRefetching}
        error={error}
      />
    </div>
  );
};

export default IpfsDirectoryPage;

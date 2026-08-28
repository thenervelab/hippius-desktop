"use client";

import React from "react";

import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  derivePreviewType,
  isLegacyOfficeFilename,
  type PreviewType,
} from "@/app/lib/utils/filePreviewType";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";

import DocumentPreview from "./DocumentPreview";
import HtmlPreview from "./HtmlPreview";
import ImagePreviewBody from "./ImagePreviewBody";
import JsonPreview from "./JsonPreview";
import MarkdownPreview from "./MarkdownPreview";
import PdfPreviewBody from "./PdfPreviewBody";
import PlainTextPreview from "./PlainTextPreview";
import PresentationPreview from "./PresentationPreview";
import PreviewSurface from "./PreviewSurface";
import { PreviewFallback, PreviewLoading } from "./PreviewState";
import SpreadsheetPreview from "./SpreadsheetPreview";
import SvgPreview from "./SvgPreview";
import VideoPreviewBody from "./VideoPreviewBody";

/**
 * Bytes-backed renderers all take the same two props, so the dispatcher can
 * pick one from a lookup rather than a per-type branch.
 */
const BYTES_RENDERERS: Partial<
  Record<
    PreviewType,
    React.ComponentType<{ localPath: string; filename: string }>
  >
> = {
  text: ({ localPath }) => <PlainTextPreview localPath={localPath} />,
  json: ({ localPath }) => <JsonPreview localPath={localPath} />,
  markdown: ({ localPath }) => <MarkdownPreview localPath={localPath} />,
  document: ({ localPath }) => <DocumentPreview localPath={localPath} />,
  presentation: ({ localPath }) => <PresentationPreview localPath={localPath} />,
  spreadsheet: SpreadsheetPreview,
  html: HtmlPreview,
  svg: SvgPreview,
};

/**
 * The single content dispatcher for a previewed file.
 *
 * It answers "what renders this file?" once, for every surface. Media
 * (image/video/PDF) keeps its existing URL-based path with all its
 * platform-specific behaviour; everything else is read through Rust's
 * `read_preview_bytes` by the renderer itself. A file whose type has no
 * renderer never reaches here as a preview — `UnifiedMediaDialog` only opens
 * for previewable files — but the unsupported branch is kept so a
 * classification change can never produce a blank viewer.
 */
export default function UnifiedFilePreview({
  file,
  handleFileDownload,
}: {
  file: FormattedUserFile;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
}) {
  const previewType = derivePreviewType(file.name);

  // Media resolves its own URL inside its body (each has its own load and
  // error handling); the bytes-backed renderers need the resolved local path,
  // which is the same hook either way — local for synced files, the Rust
  // `cache_remote_file` decrypt for cloud-only ones.
  const needsPath =
    previewType !== null && previewType !== "image" && previewType !== "video" && previewType !== "PDF";
  const resolved = useViewableFileUrl(needsPath ? file : null);

  if (previewType === "image") {
    return <ImagePreviewBody file={file} handleFileDownload={handleFileDownload} />;
  }
  if (previewType === "video") {
    return <VideoPreviewBody file={file} handleFileDownload={handleFileDownload} />;
  }
  if (previewType === "PDF") {
    return <PdfPreviewBody file={file} handleFileDownload={handleFileDownload} />;
  }

  const Renderer = previewType ? BYTES_RENDERERS[previewType] : undefined;
  if (!Renderer) {
    return (
      <PreviewSurface className="items-center justify-center">
        <PreviewFallback
          title={
            isLegacyOfficeFilename(file.name)
              ? "This older Office format can't be previewed"
              : "This file can't be previewed"
          }
          description={
            isLegacyOfficeFilename(file.name)
              ? "Download it and open it in a desktop app. Saving it as .docx, .xlsx or .pptx makes it previewable here."
              : "Download it to open it in an app that supports this format."
          }
          file={file}
          handleFileDownload={handleFileDownload}
        />
      </PreviewSurface>
    );
  }

  // The bytes come from disk, so the only wait here is the cloud decrypt for a
  // file that isn't synced locally yet.
  if (resolved.error) {
    return (
      <PreviewSurface className="items-center justify-center">
        <PreviewFallback
          title="This file couldn't be opened"
          description={resolved.error}
          file={file}
          handleFileDownload={handleFileDownload}
        />
      </PreviewSurface>
    );
  }
  if (!resolved.localPath) {
    return (
      <PreviewSurface className="items-center justify-center">
        <PreviewLoading title="Decrypting file…" />
      </PreviewSurface>
    );
  }

  return (
    <PreviewSurface>
      {/* Keyed on the path so switching files remounts the renderer rather
          than letting it reconcile a half-rendered document into a new one. */}
      <Renderer key={resolved.localPath} localPath={resolved.localPath} filename={file.name} />
    </PreviewSurface>
  );
}

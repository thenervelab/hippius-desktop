"use client";

import { type MediaUrlState, useEncryptedMediaUrl, useMediaUrl } from "@/components/chat/hooks/useMediaUrl";
import type { MatrixClient } from "matrix-js-sdk";

import type { Attachment } from "@/lib/chat/timeline";
import type { ThumbnailSpec } from "@/lib/chat/media";

/**
 * Object URL for an attachment (or its thumbnail), whichever of the
 * encrypted / plain forms it carries. Encrypted thumbnails are decrypted;
 * plain ones may be server-resized.
 */
export function useAttachmentUrl(
  client: MatrixClient,
  attachment: Attachment,
  variant: "full" | "thumbnail",
  thumbnailSpec?: ThumbnailSpec,
  enabled = true,
): MediaUrlState {
  const wantThumb = variant === "thumbnail";
  const encFile = wantThumb ? attachment.thumbnailFile ?? attachment.file : attachment.file;
  const plainUrl = wantThumb ? attachment.thumbnailUrl ?? attachment.url : attachment.url;
  const useEncrypted = Boolean(encFile);

  const encrypted = useEncryptedMediaUrl(client, useEncrypted ? encFile : null, attachment.mimetype ?? undefined, enabled);
  const plain = useMediaUrl(client, !useEncrypted && enabled ? plainUrl : null, wantThumb ? thumbnailSpec : undefined);
  return useEncrypted ? encrypted : plain;
}

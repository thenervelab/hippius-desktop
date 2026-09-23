/**
 * Media download for avatars, images and files.
 *
 * The homeserver serves media only through the authenticated endpoints
 * (`/_matrix/client/v1/media/...`), which need the bearer token: a plain
 * `<img src>` cannot fetch them. Everything goes through `fetchMedia`,
 * which returns a `Blob`; `mediaObjectUrl` caches an object URL per
 * (mxc, size) so the same avatar is fetched once per page load.
 *
 * Encrypted attachments (`content.file`) are decrypted with
 * `decryptAttachment` from `./attachments` after download.
 */

import type { MatrixClient } from "matrix-js-sdk";

import { type EncryptedFile, decryptAttachment } from "@/lib/chat/attachments";

export interface ThumbnailSpec {
  width: number;
  height: number;
  method?: "crop" | "scale";
}

export function mediaHttpUrl(client: MatrixClient, mxc: string, thumbnail?: ThumbnailSpec): string | null {
  if (thumbnail) {
    return client.mxcUrlToHttp(
      mxc,
      thumbnail.width,
      thumbnail.height,
      thumbnail.method ?? "crop",
      false,
      true,
      true,
    );
  }
  return client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
}

/** Download an unencrypted media item (or a thumbnail) as a Blob. */
export async function fetchMedia(
  client: MatrixClient,
  mxc: string,
  thumbnail?: ThumbnailSpec,
): Promise<Blob> {
  const url = mediaHttpUrl(client, mxc, thumbnail);
  if (!url) throw new Error("Invalid media URL");
  const token = client.getAccessToken();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) throw new Error(`Media download failed (${response.status})`);
  return response.blob();
}

/** Download and decrypt an encrypted attachment. */
export async function fetchEncryptedMedia(
  client: MatrixClient,
  file: EncryptedFile,
  mimetype?: string,
): Promise<Blob> {
  const ciphertext = await fetchMedia(client, file.url);
  const plaintext = await decryptAttachment(await ciphertext.arrayBuffer(), file);
  return new Blob([plaintext], { type: mimetype ?? "application/octet-stream" });
}

const objectUrlCache = new Map<string, Promise<string>>();

function cacheKey(mxc: string, thumbnail?: ThumbnailSpec): string {
  return thumbnail ? `${mxc}#${thumbnail.width}x${thumbnail.height}:${thumbnail.method ?? "crop"}` : mxc;
}

/**
 * Object URL for an unencrypted media item, cached for the page lifetime.
 * Avatars and thumbnails go through here; failures are not cached so a
 * transient error retries next time.
 */
export function mediaObjectUrl(
  client: MatrixClient,
  mxc: string,
  thumbnail?: ThumbnailSpec,
): Promise<string> {
  const key = cacheKey(mxc, thumbnail);
  const cached = objectUrlCache.get(key);
  if (cached) return cached;
  const promise = fetchMedia(client, mxc, thumbnail)
    .then((blob) => URL.createObjectURL(blob))
    .catch((error) => {
      objectUrlCache.delete(key);
      throw error;
    });
  objectUrlCache.set(key, promise);
  return promise;
}

/** Object URL for an encrypted attachment, cached by its mxc. */
export function encryptedObjectUrl(
  client: MatrixClient,
  file: EncryptedFile,
  mimetype?: string,
): Promise<string> {
  const key = `enc:${file.url}`;
  const cached = objectUrlCache.get(key);
  if (cached) return cached;
  const promise = fetchEncryptedMedia(client, file, mimetype)
    .then((blob) => URL.createObjectURL(blob))
    .catch((error) => {
      objectUrlCache.delete(key);
      throw error;
    });
  objectUrlCache.set(key, promise);
  return promise;
}

/** Release every cached object URL (sign-out). */
export function clearMediaCache(): void {
  for (const promise of objectUrlCache.values()) {
    promise.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
  }
  objectUrlCache.clear();
}

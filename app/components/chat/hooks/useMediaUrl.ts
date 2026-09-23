"use client";

import { useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";

import type { EncryptedFile } from "@/lib/chat/attachments";
import { encryptedObjectUrl, mediaObjectUrl, type ThumbnailSpec } from "@/lib/chat/media";

export type MediaUrlState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error" };

/**
 * Object URL for an `mxc://` item (optionally a server thumbnail), fetched
 * through the authenticated media endpoint. `null` mxc yields `idle`.
 */
export function useMediaUrl(
  client: MatrixClient | null,
  mxc: string | null | undefined,
  thumbnail?: ThumbnailSpec,
): MediaUrlState {
  const [state, setState] = useState<MediaUrlState>({ status: "idle" });
  const w = thumbnail?.width;
  const h = thumbnail?.height;
  const method = thumbnail?.method;

  useEffect(() => {
    if (!client || !mxc) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    mediaObjectUrl(client, mxc, w && h ? { width: w, height: h, method } : undefined)
      .then((url) => {
        if (!cancelled) setState({ status: "ready", url });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [client, mxc, w, h, method]);

  return state;
}

/** Object URL for an encrypted attachment, decrypted client-side. */
export function useEncryptedMediaUrl(
  client: MatrixClient | null,
  file: EncryptedFile | null | undefined,
  mimetype?: string,
  enabled = true,
): MediaUrlState {
  const [state, setState] = useState<MediaUrlState>({ status: "idle" });
  const url = file?.url;

  useEffect(() => {
    if (!client || !file || !enabled) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    encryptedObjectUrl(client, file, mimetype)
      .then((objectUrl) => {
        if (!cancelled) setState({ status: "ready", url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // `file` identity changes per render; `url` is the stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, url, mimetype, enabled]);

  return state;
}

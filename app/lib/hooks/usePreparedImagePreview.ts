import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

interface MotionPhotoPreview {
  isLive: boolean;
  stillPath: string | null;
  videoPath: string | null;
}

interface PreparedImagePreview {
  imageUrl: string;
  liveVideoUrl: string;
  isPreparing: boolean;
  error: string | null;
}

const EMPTY: PreparedImagePreview = {
  imageUrl: "",
  liveVideoUrl: "",
  isPreparing: false,
  error: null,
};

/**
 * Prepare an image URL for the desktop renderer.
 *
 * Rust owns Hippius Live trailer detection and extraction. HEIC conversion is
 * intentionally a renderer-only adapter: it runs locally and on demand, then
 * exposes a temporary JPEG object URL without changing the stored file.
 */
export function usePreparedImagePreview(
  resolvedUrl: string,
  localPath: string,
  fileName: string,
): PreparedImagePreview {
  const [state, setState] = useState<PreparedImagePreview>(EMPTY);

  useEffect(() => {
    if (!resolvedUrl || !localPath) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    let convertedImageUrl = "";
    let convertedVideoUrl = "";
    setState({ ...EMPTY, isPreparing: true });

    void (async () => {
      let imageUrl = resolvedUrl;
      let liveVideoUrl = "";

      try {
        const prepared = await invoke<MotionPhotoPreview>(
          "prepare_motion_photo_preview",
          { sourcePath: localPath },
        );
        if (prepared.isLive && prepared.stillPath && prepared.videoPath) {
          imageUrl = convertFileSrc(prepared.stillPath.replace(/\\/g, "/"));
          const liveVideoPath = prepared.videoPath.replace(/\\/g, "/");
          const videoAssetUrl = convertFileSrc(liveVideoPath);

          // Live clips are short. Serving a typed Blob avoids WebKitGTK
          // rejecting Tauri's custom asset URL before GStreamer can inspect
          // the MOV/MP4 payload.
          try {
            const response = await fetch(videoAssetUrl);
            if (!response.ok) {
              throw new Error(`Could not read Live Photo motion (${response.status})`);
            }
            const mimeType = liveVideoPath.toLowerCase().endsWith(".mp4")
              ? "video/mp4"
              : "video/quicktime";
            convertedVideoUrl = URL.createObjectURL(
              new Blob([await response.arrayBuffer()], { type: mimeType }),
            );
            liveVideoUrl = convertedVideoUrl;
          } catch (error) {
            console.warn("[drive] Typed Live Photo URL unavailable", error);
            liveVideoUrl = videoAssetUrl;
          }
        }
      } catch (error) {
        // Detection is best-effort. A normal browser-readable image should
        // still render even if the preparation command is unavailable.
        console.warn("[drive] Live Photo detection unavailable", error);
      }

      if (isHeicFileName(fileName)) {
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(`Could not read HEIC preview (${response.status})`);
        }
        const { heicTo } = await import("heic-to/csp");
        const jpeg = await heicTo({
          blob: await response.blob(),
          type: "image/jpeg",
          quality: 0.92,
        });
        convertedImageUrl = URL.createObjectURL(jpeg);
        imageUrl = convertedImageUrl;
      }

      if (cancelled) {
        if (convertedImageUrl) URL.revokeObjectURL(convertedImageUrl);
        if (convertedVideoUrl) URL.revokeObjectURL(convertedVideoUrl);
        convertedImageUrl = "";
        convertedVideoUrl = "";
        return;
      }
      setState({
        imageUrl,
        liveVideoUrl,
        isPreparing: false,
        error: null,
      });
    })().catch((error: unknown) => {
      if (cancelled) return;
      setState({
        ...EMPTY,
        error:
          error instanceof Error
            ? error.message
            : "This image could not be prepared for preview.",
      });
    });

    return () => {
      cancelled = true;
      if (convertedImageUrl) URL.revokeObjectURL(convertedImageUrl);
      if (convertedVideoUrl) URL.revokeObjectURL(convertedVideoUrl);
    };
  }, [fileName, localPath, resolvedUrl]);

  return state;
}

function isHeicFileName(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension === "heic" || extension === "heif";
}

export default usePreparedImagePreview;

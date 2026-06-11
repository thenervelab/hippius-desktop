import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export interface ViewableFileUrl {
  /** Asset-protocol URL for the media element (`<img>`/`<video>`/`<iframe>`). */
  url: string;
  /** Raw on-disk path behind {@link url} (for "open in system viewer"). */
  localPath: string;
  /** True while a cloud-only file is being downloaded + decrypted. */
  isLoading: boolean;
  error: string | null;
}

const EMPTY: ViewableFileUrl = {
  url: "",
  localPath: "",
  isLoading: false,
  error: null,
};

/**
 * Resolve a displayable local URL for a file shown in a preview dialog.
 *
 * Two paths:
 *  - **Local** (synced and present on disk): the plaintext file already lives
 *    in the sync folder, so `convertFileSrc(source)` serves it directly — no
 *    network, instant.
 *  - **Cloud-only / not-yet-downloaded**: there is no usable local copy, so the
 *    Rust `cache_remote_file` command downloads + decrypts it (using the drive
 *    password stored in the DB — no prompt) into a preview cache and returns
 *    the path, which we then convert. This is what makes sidebar-search results
 *    that live only on the server openable, mirroring the web console.
 *
 * A file counts as local only when it has a real `source` AND wasn't flagged
 * `pending` by the backend: a `pending` search hit carries the *would-be* local
 * path, but the bytes aren't on disk yet, so it must take the cloud path.
 */
export function useViewableFileUrl(
  file: FormattedUserFile | null,
): ViewableFileUrl {
  const { polkadotAddress } = useWalletAuth();
  const [state, setState] = useState<ViewableFileUrl>(EMPTY);

  useEffect(() => {
    if (!file) {
      setState(EMPTY);
      return;
    }

    const local = getFileUrl(file);
    // A "pending" search hit carries a would-be local path but the bytes aren't
    // on disk yet; it's told apart from a still-uploading files-table / recent
    // row (which IS on disk) by carrying a server `fileId`. Only pending+fileId
    // files take the cloud path despite having a `source` — so local previews in
    // the files table and recent files are never rerouted, delayed, or changed.
    const pendingCloud = file.syncStatus === "pending" && !!file.fileId;
    const onDisk = local.isLocal && !!local.url && !pendingCloud;
    if (onDisk) {
      setState({
        url: local.url,
        localPath: (file.source ?? "").replace(/\\/g, "/"),
        isLoading: false,
        error: null,
      });
      return;
    }

    // Cloud path needs the server file id, its drive label, and the account.
    if (!file.fileId || !file.label || !polkadotAddress) {
      setState({
        ...EMPTY,
        error: "This file can't be previewed.",
      });
      return;
    }

    let cancelled = false;
    setState({ ...EMPTY, isLoading: true });
    invoke<string>("cache_remote_file", {
      accountId: polkadotAddress,
      label: file.label,
      fileId: file.fileId,
      fileName: file.actualFileName || file.name,
      arionHash: file.arionHash ?? "",
    })
      .then((path) => {
        if (cancelled) return;
        const normalised = path.replace(/\\/g, "/");
        setState({
          url: convertFileSrc(normalised),
          localPath: normalised,
          isLoading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          typeof err === "string"
            ? err
            : ((err as { message?: string })?.message ??
              "Failed to load file.");
        setState({ ...EMPTY, error: message });
      });

    return () => {
      cancelled = true;
    };
    // Re-resolve only when the selected file's identity (or the account)
    // changes — not on unrelated object-reference churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    file?.fileId,
    file?.source,
    file?.actualFileName,
    file?.label,
    file?.syncStatus,
    polkadotAddress,
  ]);

  return state;
}

export default useViewableFileUrl;

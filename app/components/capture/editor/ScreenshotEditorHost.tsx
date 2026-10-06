"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { EDITOR_OPEN_EVENT, copySavedLink, getEditorContext, type SaveOutcome } from "@/app/lib/tauri/captureEditor";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import EditorSkeleton from "./EditorSkeleton";

/**
 * The editor (canvas, drawing and export) is its own chunk, loaded the first
 * time a picture is opened; the dark skeleton covers the page meanwhile.
 */
const EditorApp = dynamic(() => import("./EditorApp"), {
  ssr: false,
  loading: () => <EditorSkeleton />,
});

/**
 * Mounted once in the signed-in layout. Rust opens the screenshot editor
 * from the capture card, the tray's Annotate or Drive's "Edit image": it
 * brings this window forward and sends `capture_editor_open`, and the editor
 * opens here as a full-screen layer over whatever page is showing, so
 * closing it leaves the user where they were. A picture already open when
 * the window loads (a reload) is shown again rather than lost.
 *
 * After a save it says so in a toast (with "Copy link" when Rust has a link
 * for the saved file) and refreshes every list that shows files.
 */
export default function ScreenshotEditorHost() {
  // The session on screen; a new number remounts the editor fresh.
  const [session, setSession] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { polkadotAddress } = useWalletAuth();

  useEffect(() => {
    let alive = true;
    getEditorContext()
      .then((ctx) => {
        if (alive && ctx) setSession((s) => s ?? ctx.session);
      })
      .catch(() => undefined);
    const unlisten = listen<number>(EDITOR_OPEN_EVENT, (e) => setSession(e.payload));
    return () => {
      alive = false;
      void unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, []);

  const onClose = useCallback(
    (outcome: SaveOutcome | null) => {
      setSession(null);
      if (!outcome) return;
      void notifyFilesMutated(queryClient, polkadotAddress);
      toast.success(outcome.title, {
        description: outcome.message,
        action: outcome.offerLink
          ? {
              label: "Copy link",
              onClick: () => {
                void copySavedLink()
                  .then((r) => (r.status === "copied" ? toast.success("Link copied") : toast.error(r.message)))
                  .catch(() => toast.error("The link couldn't be copied. Try again."));
              },
            }
          : undefined,
      });
    },
    [queryClient, polkadotAddress],
  );

  if (session === null) return null;
  return <EditorApp key={session} onClose={onClose} />;
}

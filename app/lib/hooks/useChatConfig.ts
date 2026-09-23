// Fetch the chat configuration once and stash it in `chatConfigAtom` so the
// sidebar entry and the `/chat` route gate on the same answer.
//
// Mounted in the always-on event-listener layer (next to
// `useServerCapabilities` in `SyncEventLogger`). The config is static for
// the life of the process (release channel + env), so one fetch is enough;
// it does not depend on the signed-in account.

import { useEffect } from "react";
import { useSetAtom } from "jotai";

import { chatConfigAtom } from "@/app/lib/global-atoms/chatAtoms";
import { chatGetConfig } from "@/app/lib/tauri/chat";

export function useChatConfig(): void {
  const setConfig = useSetAtom(chatConfigAtom);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await chatGetConfig();
        if (!cancelled) setConfig(config);
      } catch (err) {
        // An IPC failure hides the feature; a page-level retry is not
        // worth a surface for a static config.
        console.warn("[useChatConfig] config fetch failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setConfig]);
}

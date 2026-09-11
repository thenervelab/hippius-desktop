"use client";

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { FolderSymlink } from "lucide-react";

import { SettingsCard } from "./SettingsCard";
import { SettingsToggle } from "./SettingsToggle";

/** Wire shape of `finder_extension_state`. */
type FinderExtensionState = { kind: "enabled" | "disabled" | "muted" | "unsupported" };

/** The two words `set_finder_extension_preference` accepts. */
type FinderExtensionPreference = "wanted" | "unwanted";

/**
 * The switch for "Share with Hippius" in Finder.
 *
 * Rust owns the decision: `finder_extension_state` reports what macOS says
 * combined with the user's stored preference, and
 * `set_finder_extension_preference` both records the preference and acts on
 * it (elects the extension for `wanted`, switches it off for `unwanted`).
 * This row only renders the answer and relays the click — it is the way
 * back for a user who chose "Don't ask again" on the nudge, which is why it
 * shows `muted` as off rather than hiding.
 *
 * Renders nothing when the state is `unsupported`: no extension in this
 * build (a dev binary), a translocated launch, or a platform without Finder.
 * The parent already limits the mount to macOS; this is the second guard.
 */
export default function FinderExtensionSetting() {
  const [state, setState] = useState<FinderExtensionState["kind"] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<FinderExtensionState>("finder_extension_state");
      setState(next.kind);
    } catch {
      // An older backend, or an IPC failure: no row rather than a wrong one.
      setState("unsupported");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setPreference = async (preference: FinderExtensionPreference) => {
    setBusy(true);
    try {
      // The switch is the one surface whose "off" means the extension itself,
      // so it is the one caller that asks Rust to run the off verb.
      const next = await invoke<FinderExtensionState>("set_finder_extension_preference", {
        preference,
        switchOff: preference === "unwanted",
      });
      setState(next.kind);
      if (preference === "wanted" && next.kind !== "enabled") {
        // Registered and elected but macOS does not read it as on yet — the
        // Enable path's own fallback copy names the pane to check.
        toast.warning("Hippius could not turn the Finder extension on", {
          description:
            "Open System Settings › General › Login Items & Extensions › File Providers and turn on Hippius.",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Could not change the Finder extension", { description: message });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (state === null || state === "unsupported") return null;

  const enabled = state === "enabled";

  return (
    <SettingsCard label="Finder" icon={<FolderSymlink className="size-4" />}>
      <div className="flex items-center justify-between gap-4 px-[12px] py-[10px]">
        <div className="min-w-0">
          <p className="font-geist text-[14px] leading-[20px] font-medium text-[#0A0A0A] dark:text-white">
            Show &ldquo;Share with Hippius&rdquo; in Finder
          </p>
          <p className="font-geist text-[12px] leading-[18px] text-[#7D7D7D] dark:text-grey-dark-600">
            {enabled
              ? "Right-click a file in your Hippius folder to share it."
              : "Turn this on to share files from Finder's right-click menu."}
          </p>
        </div>
        <SettingsToggle
          checked={enabled}
          disabled={busy}
          onCheckedChange={(on) => void setPreference(on ? "wanted" : "unwanted")}
        />
      </div>
    </SettingsCard>
  );
}

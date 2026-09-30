"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FOLDER_ROLES_ENABLED, SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  driveInvitesVersionAtom,
  inviteKeyDeliveredVersionAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { invalidateOwnedDriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import {
  INVITE_KEY_DELIVERED_EVENT,
  startInviteAutoSeal,
  stopInviteAutoSeal,
  type InviteKeyDelivered,
} from "@/app/lib/tauri/sharedDrives";
import { registerTauriListeners } from "@/lib/utils/tauriListeners";

/** "ada@example.com can join Team.", or "Someone can join Team." */
export function inviteKeyDeliveredMessage(delivered: InviteKeyDelivered): string {
  const email = delivered.recipientEmail?.trim();
  return `${email || "Someone"} can join ${delivered.label}.`;
}

/**
 * Invisible: while signed in, lets Rust deliver emailed invitations' keys
 * without an Approve click, and tells the owner when it did.
 *
 * Rust owns the whole job (`shared_drives::auto_seal`: own drives only,
 * never prompts for a key, follows the plan, polls cheaply). This starts it
 * behind the same flags that show the manual Approve, and on each delivery
 * shows a toast and refreshes whatever lists the invitation, so its row moves
 * from "Opened" to "Approved".
 */
export default function InviteAutoSealListener() {
  const queryClient = useQueryClient();
  const bumpInvites = useSetAtom(driveInvitesVersionAtom);
  const bumpDelivered = useSetAtom(inviteKeyDeliveredVersionAtom);

  useEffect(() => {
    if (!SHARED_DRIVES_ENABLED) return;
    void startInviteAutoSeal(FOLDER_ROLES_ENABLED).catch((err: unknown) => {
      console.warn("[InviteAutoSeal] could not start", err);
    });
    const { cleanup } = registerTauriListeners([
      [
        INVITE_KEY_DELIVERED_EVENT,
        (event) => {
          const delivered = event.payload as InviteKeyDelivered;
          toast.success(inviteKeyDeliveredMessage(delivered));
          bumpDelivered((n) => n + 1);
          bumpInvites((n) => n + 1);
          void invalidateOwnedDriveSharing(queryClient);
        },
      ],
    ]);
    return () => {
      cleanup();
      void stopInviteAutoSeal().catch(() => undefined);
    };
  }, [queryClient, bumpInvites, bumpDelivered]);

  return null;
}

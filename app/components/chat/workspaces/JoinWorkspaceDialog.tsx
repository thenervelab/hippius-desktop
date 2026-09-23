"use client";

import { useAtom, useSetAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Mail } from "lucide-react";

import { joinWorkspaceOpenAtom, rightPanelAtom, selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import { dialogContentClassName, dialogSecondaryButtonClassName, dialogTitleClassName } from "@/components/chat/dialog-styles";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import JoinWorkspaceList from "@/components/chat/workspaces/JoinWorkspaceList";
import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";

/** "Join a workspace" from the rail's "+": invitations and the community. Ported from the console. */
export default function JoinWorkspaceDialog({ client, workspaces }: { client: MatrixClient; workspaces: WorkspacesState }) {
  const [open, setOpen] = useAtom(joinWorkspaceOpenAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const inCommunity = workspaces.workspaces.some((w) => w.isCommunity);

  return (
    <FramedDialog
      open={open}
      onClose={() => setOpen(false)}
      title="Join a workspace"
      icon={<Mail className="size-[17px] text-white" aria-hidden />}
      maxWidth="max-w-[600px]"
      contentClassName={dialogContentClassName}
      titleClassName={dialogTitleClassName}
    >
      <JoinWorkspaceList
        client={client}
        className="mt-4"
        invites={workspaces.invites}
        inCommunity={inCommunity}
        onJoined={(spaceId) => {
          workspaces.setActiveWorkspaceId(spaceId);
          setSelectedRoomId(null);
          setRightPanel(null);
          setOpen(false);
        }}
      />
      <Button type="button" size="auto" onClick={() => setOpen(false)} className={`${dialogSecondaryButtonClassName} mt-4`}>
        Close
      </Button>
    </FramedDialog>
  );
}

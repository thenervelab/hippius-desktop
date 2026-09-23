"use client";

import { useAtom, useSetAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Building2 } from "lucide-react";

import { createWorkspaceOpenAtom, rightPanelAtom, selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import { dialogContentClassName, dialogTitleClassName } from "@/components/chat/dialog-styles";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import CreateWorkspaceForm from "@/components/chat/workspaces/CreateWorkspaceForm";
import FramedDialog from "@/components/ui/FramedDialog";

/** "Create a workspace" from the rail's "+", for people who already have one. Ported from the console. */
export default function CreateWorkspaceDialog({ client, workspaces }: { client: MatrixClient; workspaces: WorkspacesState }) {
  const [open, setOpen] = useAtom(createWorkspaceOpenAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);

  return (
    <FramedDialog
      open={open}
      onClose={() => setOpen(false)}
      title="Create a workspace"
      icon={<Building2 className="size-[17px] text-white" aria-hidden />}
      maxWidth="max-w-[600px]"
      contentClassName={dialogContentClassName}
      titleClassName={dialogTitleClassName}
    >
      {open ? (
        <CreateWorkspaceForm
          key="create"
          client={client}
          className="mt-4"
          onCancel={() => setOpen(false)}
          onCreated={({ spaceId, channelIds }) => {
            workspaces.setActiveWorkspaceId(spaceId);
            setSelectedRoomId(channelIds[0] ?? null);
            setRightPanel(null);
            setOpen(false);
          }}
        />
      ) : null}
    </FramedDialog>
  );
}

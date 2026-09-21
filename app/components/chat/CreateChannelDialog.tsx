"use client";

import { type FormEvent, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { ArrowRight, Hash, Lock, Star } from "lucide-react";
import { toast } from "sonner";

import { createChannelCategoryAtom, createChannelOpenAtom, rightPanelAtom, selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import {
  dialogContentClassName,
  dialogControlClassName,
  dialogHintClassName,
  dialogLabelClassName,
  dialogPrimaryButtonClassName,
  dialogSecondaryButtonClassName,
  dialogTitleClassName,
  dialogToggleRowClassName,
} from "@/components/chat/dialog-styles";
import ToggleSwitch from "@/components/chat/ToggleSwitch";
import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select/Select";
import { createChannel, slugifyChannelName } from "@/lib/chat/rooms";
import { cn } from "@/lib/utils";
import { channelOrderKey, createWorkspaceChannel } from "@/lib/chat/spaces";

/** `Select` value for "no category" (Radix rejects the empty string). */
const NO_CATEGORY = "__none__";

/**
 * "New channel" in the active workspace: name, optional topic, and whether
 * it is a default for newcomers. Workspace channels are restricted to the
 * Space's members (anyone in the workspace can find and join them) and
 * not encrypted, so latecomers read the history, like a Slack channel.
 *
 * Without a workspace (orphan mode) the pre-workspace behaviour remains:
 * a public aliased channel or a private encrypted one.
 */
export default function CreateChannelDialog({ client, workspaces }: { client: MatrixClient; workspaces?: WorkspacesState }) {
  const [open, setOpen] = useAtom(createChannelOpenAtom);
  // Preselected by whoever opened the dialog (a category's "+"); read once
  // per opening and reset on close so the next opening starts clean.
  const [categoryId, setCategoryId] = useAtom(createChannelCategoryAtom);
  const active = workspaces?.active ?? null;
  const existing = workspaces?.channels ?? [];
  const groups = workspaces?.groups ?? { uncategorised: [], categories: [] };
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  // One switch, two meanings: "default channel" inside a workspace,
  // "make private" for a channel outside any workspace.
  const [toggle, setToggle] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const category = groups.categories.find((c) => c.id === categoryId) ?? null;
  const categoryOptions = [{ value: NO_CATEGORY, label: "No category" }, ...groups.categories.map((c) => ({ value: c.id, label: c.name }))];
  // The new channel goes last in whatever lists it.
  const siblings = category ? category.channels.length : groups.uncategorised.length;

  const slug = slugifyChannelName(name);
  const duplicate = active !== null && existing.some((c) => slugifyChannelName(c.name) === slug);
  // Anyone can create a room; linking it into the workspace is what the
  // Space's power levels govern. Do not let someone fill the form in and
  // fail at the last step.
  const forbidden = active !== null && !active.canCreateChannels;
  const canSubmit = slug.length > 0 && !submitting && !duplicate && !forbidden;

  const reset = () => {
    setName("");
    setTopic("");
    setToggle(false);
    setCategoryId(null);
  };

  const close = () => {
    if (submitting) return;
    reset();
    setOpen(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const roomId = active
        ? await createWorkspaceChannel(client, active.id, {
            name: slug,
            topic: topic.trim() || undefined,
            isDefault: toggle,
            order: channelOrderKey(siblings),
            categoryId: category?.id ?? null,
          })
        : await createChannel(client, { name, topic, isPublic: !toggle });
      toast.success(`#${slug} created`);
      setSelectedRoomId(roomId);
      setRightPanel(null);
      reset();
      setOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create the channel";
      toast.error(/M_ROOM_IN_USE|alias/i.test(message) ? `#${slug} already exists. Pick another name.` : message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title={active ? <span title={active.name}>Create a channel in {active.name}</span> : "Create a channel"}
      icon={<Hash className="size-[17px] text-white" aria-hidden />}
      maxWidth="max-w-[600px]"
      contentClassName={dialogContentClassName}
      titleClassName={dialogTitleClassName}
    >
      {forbidden && active ? (
        <div className="mt-4 font-geist">
          <p role="status" className="rounded-md border border-grey-80 bg-grey-90/60 px-3 py-2.5 text-sm text-grey-30 dark:border-black-500 dark:bg-black-500/60 dark:text-grey-dark-200">
            Only admins and owners can add channels to {active.name}. Ask one of them to create it, or to make you an admin.
          </p>
          <Button type="button" variant="default" size="default" className="mt-4 w-full" onClick={close}>
            Close
          </Button>
        </div>
      ) : (
      <form onSubmit={submit} className="mt-4 flex flex-col gap-4 font-geist">
        <div>
          <label htmlFor="chat-new-channel-name" className={dialogLabelClassName}>
            Name
          </label>
          <Input
            id="chat-new-channel-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. product-design"
            maxLength={80}
            wrapperClassName={dialogControlClassName}
            startAdornment={<Hash className="size-4 text-grey-60 dark:text-grey-dark-700" aria-hidden />}
          />
          <p className={cn(dialogHintClassName, duplicate && "text-error-50 dark:text-error-40")}>
            {duplicate
              ? `#${slug} already exists in this workspace.`
              : slug
                ? active
                  ? `Everyone in ${active.name} can find and join #${slug}.`
                  : `Channel address: #${slug}`
                : "Channels are where your team talks about a topic."}
          </p>
        </div>

        <div>
          <label htmlFor="chat-new-channel-topic" className={dialogLabelClassName}>
            Topic <span className="font-normal text-grey-60 dark:text-grey-dark-700">(optional)</span>
          </label>
          <Input
            id="chat-new-channel-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What is this channel about?"
            maxLength={250}
            wrapperClassName={dialogControlClassName}
          />
        </div>

        {active && groups.categories.length > 0 ? (
          <div>
            <p id="chat-new-channel-category-label" className={dialogLabelClassName}>
              Category
            </p>
            <Select
              ariaLabel="Category"
              options={categoryOptions}
              value={category?.id ?? NO_CATEGORY}
              onValueChange={(value) => setCategoryId(value === NO_CATEGORY ? null : value)}
              className="mt-1.5"
            />
            <p className={dialogHintClassName}>{category ? `Listed under ${category.name} in the sidebar.` : "Listed at the top of the channel list."}</p>
          </div>
        ) : null}

        {active ? (
          <div className={dialogToggleRowClassName}>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-grey-10 dark:text-grey-light-100">
                <Star className="size-3.5" aria-hidden /> Default channel
              </p>
              <p className="mt-0.5 text-xs text-grey-60 dark:text-grey-dark-700">
                {toggle ? "New members are added to this channel when they join." : "Members join it themselves from the channel list."}
              </p>
            </div>
            <ToggleSwitch checked={toggle} onChange={setToggle} ariaLabel="Default channel" className="mt-0.5" />
          </div>
        ) : (
          <div className={dialogToggleRowClassName}>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-grey-10 dark:text-grey-light-100">
                <Lock className="size-3.5" aria-hidden /> Make private
              </p>
              <p className="mt-0.5 text-xs text-grey-60 dark:text-grey-dark-700">
                {toggle
                  ? "Only invited people can find and join. Messages are end-to-end encrypted."
                  : "Anyone in your team can find and join this channel."}
              </p>
            </div>
            <ToggleSwitch checked={toggle} onChange={setToggle} ariaLabel="Make private" className="mt-0.5" />
          </div>
        )}

        <div className="space-y-3 pt-1">
          <Button
            type="submit"
            variant="primary"
            size="auto"
            className={dialogPrimaryButtonClassName}
            disabled={!canSubmit}
            loading={submitting}
          >
            <span>Create channel</span>
            {!submitting ? <ArrowRight className="size-[18px]" strokeWidth={2} aria-hidden /> : null}
          </Button>
          <Button type="button" size="auto" onClick={close} disabled={submitting} className={dialogSecondaryButtonClassName}>
            Cancel
          </Button>
        </div>
      </form>
      )}
    </FramedDialog>
  );
}

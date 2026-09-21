"use client";

import { type FormEvent, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { ArrowRight, Hash, Plus, X } from "lucide-react";
import { toast } from "sonner";

import {
  dialogControlClassName,
  dialogHintClassName,
  dialogLabelClassName,
  dialogPrimaryButtonClassName,
  dialogSecondaryButtonClassName,
} from "@/components/chat/dialog-styles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { slugifyChannelName } from "@/lib/chat/rooms";
import { type CreateWorkspaceResult, createWorkspace } from "@/lib/chat/spaces";
import { cn } from "@/lib/utils";

export const DEFAULT_WORKSPACE_CHANNELS = ["general", "random"] as const;

interface CreateWorkspaceFormProps {
  client: MatrixClient;
  onCreated: (result: CreateWorkspaceResult, name: string) => void;
  onCancel?: () => void;
  /** Prefix for element ids, so two forms can coexist on a page. */
  idPrefix?: string;
  className?: string;
}

/**
 * Add a channel slug to the list if it is new and non-empty. Pure, so the
 * chip behaviour is testable without a DOM.
 */
export function addChannelSlug(list: readonly string[], raw: string): string[] {
  const slug = slugifyChannelName(raw);
  if (!slug || list.includes(slug)) return [...list];
  return [...list, slug];
}

/**
 * Ported from the console's `CreateWorkspaceForm`.
 *
 * Name, optional description, and the channels to start with (`general`
 * and `random`, editable). Every starting channel is a default: new
 * members are invited to all of them. Creation is several requests; the
 * status line under the button says which one is in flight.
 */
export default function CreateWorkspaceForm({ client, onCreated, onCancel, idPrefix = "chat-new-workspace", className }: CreateWorkspaceFormProps) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [channels, setChannels] = useState<string[]>([...DEFAULT_WORKSPACE_CHANNELS]);
  const [channelDraft, setChannelDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && channels.length > 0 && !submitting;

  const commitDraft = () => {
    if (!channelDraft.trim()) return;
    setChannels((list) => addChannelSlug(list, channelDraft));
    setChannelDraft("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setStatus(null);
    try {
      const result = await createWorkspace(
        client,
        {
          name: trimmed,
          topic: topic.trim() || undefined,
          channels: channels.map((c) => ({ name: c, isDefault: true })),
        },
        ({ done, total, label }) => setStatus(`${label} (${Math.min(done + 1, total)}/${total})`),
      );
      toast.success(`${trimmed} is ready`);
      onCreated(result, trimmed);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the workspace");
      setStatus(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-4 font-geist", className)} aria-busy={submitting}>
      <div>
        <label htmlFor={`${idPrefix}-name`} className={dialogLabelClassName}>
          Workspace name
        </label>
        <Input
          id={`${idPrefix}-name`}
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Acme Corp"
          maxLength={80}
          disabled={submitting}
          wrapperClassName={dialogControlClassName}
        />
        <p className={dialogHintClassName}>The name of your company or team. You can change it later.</p>
      </div>

      <div>
        <label htmlFor={`${idPrefix}-topic`} className={dialogLabelClassName}>
          Description <span className="font-normal text-grey-60 dark:text-grey-dark-700">(optional)</span>
        </label>
        <Input
          id={`${idPrefix}-topic`}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="What is this workspace for?"
          maxLength={250}
          disabled={submitting}
          wrapperClassName={dialogControlClassName}
        />
      </div>

      <div>
        <p className={dialogLabelClassName} id={`${idPrefix}-channels-label`}>
          Starting channels
        </p>
        <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-labelledby={`${idPrefix}-channels-label`}>
          {channels.map((channel) => (
            <li
              key={channel}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-grey-80 bg-grey-light-600 pl-2 pr-1 text-xs font-medium text-grey-10 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-light-100"
            >
              <Hash className="size-3 text-grey-60 dark:text-grey-dark-700" aria-hidden />
              {channel}
              <button
                type="button"
                onClick={() => setChannels((list) => list.filter((c) => c !== channel))}
                disabled={submitting || channels.length === 1}
                aria-label={`Remove #${channel}`}
                className="ml-0.5 inline-flex size-4 items-center justify-center rounded text-grey-60 outline-none hover:bg-grey-80 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 disabled:opacity-40 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center gap-2">
          <Input
            id={`${idPrefix}-channel-draft`}
            aria-label="Add a channel"
            value={channelDraft}
            onChange={(e) => setChannelDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commitDraft();
              }
            }}
            onBlur={commitDraft}
            placeholder="Add a channel…"
            maxLength={64}
            disabled={submitting}
            wrapperClassName="min-h-9 flex-1 items-center"
            startAdornment={<Hash className="size-3.5 text-grey-60 dark:text-grey-dark-700" aria-hidden />}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100"
            aria-label="Add channel"
            onClick={commitDraft}
            disabled={submitting || !channelDraft.trim()}
          >
            <Plus className="size-4" aria-hidden />
          </Button>
        </div>
        <p className={dialogHintClassName}>Everyone you invite joins these channels. Channels are visible to the whole workspace.</p>
      </div>

      <div className="space-y-3 pt-1">
        <Button type="submit" variant="primary" size="auto" className={dialogPrimaryButtonClassName} disabled={!canSubmit} loading={submitting}>
          <span>Create workspace</span>
          {!submitting ? <ArrowRight className="size-[18px]" strokeWidth={2} aria-hidden /> : null}
        </Button>
        {status ? (
          <p role="status" className="text-center text-xs text-grey-60 dark:text-grey-dark-700">
            {status}
          </p>
        ) : null}
        {onCancel ? (
          <Button type="button" size="auto" onClick={onCancel} disabled={submitting} className={dialogSecondaryButtonClassName}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

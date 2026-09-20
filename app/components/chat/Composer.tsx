"use client";

import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { type MatrixClient, type MatrixEvent, MsgType, type Room } from "matrix-js-sdk";
import { Bold, Code, Italic, Paperclip, Pencil, Reply, SendHorizontal, Smile, Strikethrough, X } from "lucide-react";
import { toast } from "sonner";

import { chatServerNameAtom, editingEventIdAtom, replyToEventIdAtom, selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import EmojiPicker from "@/components/chat/EmojiPicker";
import UploadList, { type UploadItem } from "@/components/chat/UploadList";
import UserAvatar from "@/components/chat/UserAvatar";
import CustomTooltip from "@/components/chat/ChatTooltip";
import {
  type Trigger,
  TypingNotifier,
  applyCompletion,
  editText,
  editableSource,
  loadDraft,
  matchingCommands,
  parseInput,
  saveDraft,
  sendFile,
  sendText,
  triggerAt,
} from "@/lib/chat/compose";
import { type Emoji, replaceShortcodes, searchEmoji } from "@/lib/chat/emoji";
import type { MentionTarget } from "@/lib/chat/markdown";
import { isValidUserId, normaliseUserId, openDirectRoom, setRoomMuted } from "@/lib/chat/rooms";
import { eventPreview } from "@/lib/chat/threads";
import { canEdit } from "@/lib/chat/timeline";
import { cn } from "@/lib/utils";

interface ComposerProps {
  client: MatrixClient;
  room: Room;
  /** Thread root when composing inside the thread panel. */
  threadRootId?: string | null;
  /** Events the ↑ key may edit (the visible timeline, oldest first). */
  events: readonly MatrixEvent[];
  placeholder: string;
  autoFocus?: boolean;
}

type Suggestion =
  | { kind: "mention"; userId: string; displayName: string; avatarMxc: string | null }
  | { kind: "emoji"; emoji: Emoji }
  | { kind: "command"; name: string; args: string; description: string };

/** What `/gif` says until the picker ships on desktop. */
export const GIF_UNAVAILABLE_MESSAGE = "GIFs are not available in the desktop app yet";

const TOOL_BUTTON =
  "inline-flex size-7 items-center justify-center rounded-md text-grey-60 hover:bg-grey-90 hover:text-grey-10 disabled:opacity-40 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100";

/**
 * Slack-style composer: Enter sends, Shift+Enter breaks, Esc cancels an
 * edit or reply, ↑ on an empty box edits your last message. Autocomplete
 * for `@`, `:` and `/`; formatting buttons wrap the selection in markdown;
 * files arrive by button, paste or drop; drafts persist per room.
 */
export default function Composer({ client, room, threadRootId = null, events, placeholder, autoFocus }: ComposerProps) {
  const me = client.getUserId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => loadDraft(room.roomId, threadRootId));
  const [mentions, setMentions] = useState<MentionTarget[]>([]);
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [editingId, setEditingId] = useAtom(editingEventIdAtom);
  const [replyToId, setReplyToId] = useAtom(replyToEventIdAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const serverName = useAtomValue(chatServerNameAtom);
  const typing = useMemo(() => new TypingNotifier(client, room.roomId), [client, room.roomId]);

  const editing = editingId ? events.find((e) => e.getId() === editingId) ?? null : null;
  const replyTo = replyToId ? events.find((e) => e.getId() === replyToId) ?? room.findEventById(replyToId) ?? null : null;
  const isThisScope = (event: MatrixEvent | null) => !!event && (event.threadRootId ?? null) === threadRootId;

  // Restore draft on room / thread switch; drop stale edit state.
  useEffect(() => {
    setText(loadDraft(room.roomId, threadRootId));
    setMentions([]);
    setTrigger(null);
  }, [room.roomId, threadRootId]);

  useEffect(() => () => typing.stop(), [typing]);

  // Load the message into the box when an edit begins in this scope.
  useEffect(() => {
    if (editing && isThisScope(editing)) {
      setText(editableSource(editing));
      textareaRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  useEffect(() => {
    if (replyTo && isThisScope(replyTo)) textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyToId]);

  // Auto-grow up to ~10 lines.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const updateText = (next: string, caret?: number) => {
    setText(next);
    if (!editing) saveDraft(room.roomId, threadRootId, next);
    if (next.trim()) typing.typing();
    else typing.stop();
    const at = caret ?? textareaRef.current?.selectionStart ?? next.length;
    setTrigger(triggerAt(next, at));
    setActiveSuggestion(0);
  };

  const suggestions: Suggestion[] = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "mention") {
      const q = trigger.query.toLowerCase();
      return room
        .getJoinedMembers()
        .filter((m) => m.userId !== me && (m.name.toLowerCase().includes(q) || m.userId.toLowerCase().includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 8)
        .map((m) => ({ kind: "mention" as const, userId: m.userId, displayName: m.name, avatarMxc: m.getMxcAvatarUrl() ?? null }));
    }
    if (trigger.kind === "emoji") return searchEmoji(trigger.query, 8).map((emoji) => ({ kind: "emoji" as const, emoji }));
    if (threadRootId) return []; // no slash commands in threads
    return matchingCommands(trigger.query).map((c) => ({ kind: "command" as const, ...c }));
  }, [trigger, room, me, threadRootId]);

  const accept = (suggestion: Suggestion) => {
    if (!trigger) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    let replacement: string;
    if (suggestion.kind === "mention") {
      replacement = `@${suggestion.displayName}`;
      setMentions((prev) => (prev.some((m) => m.userId === suggestion.userId) ? prev : [...prev, { userId: suggestion.userId, displayName: suggestion.displayName }]));
    } else if (suggestion.kind === "emoji") {
      replacement = suggestion.emoji.char;
    } else {
      replacement = `/${suggestion.name}`;
    }
    const next = applyCompletion(text, trigger.start, caret, replacement);
    setText(next.text);
    setTrigger(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  const cancelEditOrReply = () => {
    if (editing) {
      setEditingId(null);
      setText(loadDraft(room.roomId, threadRootId));
    } else if (replyTo) {
      setReplyToId(null);
    }
  };

  const runCommand = async (name: string, args: string): Promise<boolean> => {
    switch (name) {
      case "me":
        if (!args) return false;
        await sendText(client, room, args, { mentions, threadRootId, msgtype: MsgType.Emote });
        return true;
      case "shrug":
        await sendText(client, room, `${args ? `${args} ` : ""}¯\\_(ツ)_/¯`, { mentions, threadRootId });
        return true;
      case "topic":
        await client.setRoomTopic(room.roomId, args);
        toast.success("Topic updated");
        return true;
      case "invite": {
        const id = normaliseUserId(args, serverName);
        if (!isValidUserId(id)) throw new Error("Use /invite @user:server");
        await client.invite(room.roomId, id);
        toast.success(`Invited ${id}`);
        return true;
      }
      case "kick": {
        const [who, ...rest] = args.split(/\s+/);
        const id = normaliseUserId(who ?? "", serverName);
        if (!isValidUserId(id)) throw new Error("Use /kick @user:server [reason]");
        await client.kick(room.roomId, id, rest.join(" ") || undefined);
        return true;
      }
      case "leave":
        await client.leave(room.roomId);
        setSelectedRoomId(null);
        return true;
      case "join": {
        if (!args) throw new Error("Use /join #alias:server");
        const joined = await client.joinRoom(args);
        setSelectedRoomId(joined.roomId);
        return true;
      }
      case "mute":
      case "unmute":
        await setRoomMuted(client, room.roomId, name === "mute");
        toast.success(name === "mute" ? "Channel muted" : "Channel unmuted");
        return true;
      case "dm": {
        const id = normaliseUserId(args, serverName);
        if (!isValidUserId(id)) throw new Error("Use /dm @user:server");
        setSelectedRoomId(await openDirectRoom(client, id));
        return true;
      }
      case "gif":
        // The command is recognised so it autocompletes like the console's,
        // but the GIF picker is not in the desktop app yet.
        throw new Error(GIF_UNAVAILABLE_MESSAGE);
      default:
        return false;
    }
  };

  const submit = async () => {
    const source = replaceShortcodes(text).replace(/\s+$/, "");
    if (!source.trim() || sending) return;
    const liveMentions = mentions.filter((m) => source.includes(`@${m.displayName}`));
    setSending(true);
    typing.stop();
    try {
      if (editing) {
        if (source !== editableSource(editing)) await editText(client, room, editing, source, liveMentions);
        setEditingId(null);
        setText(loadDraft(room.roomId, threadRootId));
      } else {
        const parsed = threadRootId ? { kind: "text" as const, text: source } : parseInput(source);
        if (parsed.kind === "unknown-command") {
          toast.error(`Unknown command /${parsed.name}. Start with // to send a literal slash.`);
          return;
        }
        if (parsed.kind === "command") {
          if (!(await runCommand(parsed.name, parsed.args))) return;
        } else {
          await sendText(client, room, parsed.text, { mentions: liveMentions, threadRootId, replyTo });
        }
        setReplyToId(null);
        setText("");
        saveDraft(room.roomId, threadRootId, "");
      }
      setMentions([]);
      setTrigger(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send");
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const wrapSelection = (marker: string, block = false) => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const selected = text.slice(s, e);
    const open = block ? `${marker}\n` : marker;
    const close = block ? `\n${marker}` : marker;
    const next = `${text.slice(0, s)}${open}${selected}${close}${text.slice(e)}`;
    updateText(next, s + open.length + selected.length);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + open.length, s + open.length + selected.length);
    });
  };

  const insertAtCaret = (snippet: string) => {
    const el = textareaRef.current;
    const s = el?.selectionStart ?? text.length;
    const e = el?.selectionEnd ?? text.length;
    const next = `${text.slice(0, s)}${snippet}${text.slice(e)}`;
    updateText(next, s + snippet.length);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(s + snippet.length, s + snippet.length);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length && trigger) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSuggestion((i) => (i + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSuggestion((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        accept(suggestions[activeSuggestion]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEditOrReply();
      return;
    }
    if (event.key === "ArrowUp" && !text && !editing) {
      const mine = [...events].reverse().find((e) => e.getSender() === me && canEdit(client, e) && (e.threadRootId ?? null) === threadRootId);
      if (mine?.getId()) {
        event.preventDefault();
        setEditingId(mine.getId()!);
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
      if (event.key === "b") {
        event.preventDefault();
        wrapSelection("*");
      } else if (event.key === "i") {
        event.preventDefault();
        wrapSelection("_");
      } else if (event.key === "e") {
        event.preventDefault();
        wrapSelection("`");
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      wrapSelection("~");
    }
  };

  // ---- files
  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      for (const file of list) {
        const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const abort = new AbortController();
        setUploads((prev) => [...prev, { id, name: file.name, size: file.size, loaded: 0, status: "uploading", abort }]);
        void sendFile(client, room, file, {
          threadRootId,
          abort,
          onProgress: ({ loaded }) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, loaded } : u))),
        })
          .then(() => setUploads((prev) => prev.filter((u) => u.id !== id)))
          .catch((error: unknown) => {
            if (abort.signal.aborted) {
              setUploads((prev) => prev.filter((u) => u.id !== id));
              return;
            }
            const message = error instanceof Error ? error.message : "Upload failed";
            setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, status: "failed", error: message } : u)));
          });
      }
    },
    [client, room, threadRootId],
  );

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };
  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = "";
  };

  const canSend = text.trim().length > 0 && !sending;
  const activeBanner = editing && isThisScope(editing) ? "edit" : replyTo && isThisScope(replyTo) ? "reply" : null;

  return (
    <div
      className={cn("relative shrink-0 px-4 pb-3 pt-1", dragging && "outline-dashed outline-2 -outline-offset-4 outline-primary-50 dark:outline-primary-40")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {activeBanner ? (
        <div className="mb-1 flex items-center gap-2 rounded-t-lg border border-b-0 border-grey-80 bg-grey-light-600 px-3 py-1.5 text-xs text-grey-60 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-700">
          {activeBanner === "edit" ? <Pencil className="size-3.5 shrink-0" aria-hidden /> : <Reply className="size-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">
            {activeBanner === "edit" ? (
              "Editing message"
            ) : (
              <>
                Replying to <span className="font-medium text-grey-10 dark:text-grey-light-100">{room.getMember(replyTo!.getSender() ?? "")?.name ?? replyTo!.getSender()}</span>
                {" — "}
                {eventPreview(replyTo!, 60)}
              </>
            )}
          </span>
          <button type="button" onClick={cancelEditOrReply} aria-label="Cancel" className="text-grey-60 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-grey-light-100">
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      <div
        className={cn(
          "rounded-lg border border-grey-80 bg-white focus-within:border-primary-50 dark:border-black-500 dark:bg-black-300 dark:focus-within:border-primary-40",
          activeBanner && "rounded-t-none",
        )}
      >
        {suggestions.length && trigger ? (
          <ul
            role="listbox"
            aria-label="Suggestions"
            className="absolute bottom-full left-4 right-4 z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border border-grey-80 bg-white p-1 shadow-dialog dark:border-black-300 dark:bg-black-300"
          >
            {suggestions.map((s, i) => (
              <li
                key={s.kind === "mention" ? s.userId : s.kind === "emoji" ? s.emoji.name : s.name}
                role="option"
                aria-selected={i === activeSuggestion}
                onMouseEnter={() => setActiveSuggestion(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(s);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-grey-10 dark:text-grey-light-100",
                  i === activeSuggestion && "bg-grey-90 dark:bg-black-500",
                )}
              >
                {s.kind === "mention" ? (
                  <>
                    <UserAvatar client={client} seed={s.userId} avatarMxc={s.avatarMxc} size={20} />
                    <span className="font-medium">{s.displayName}</span>
                    <span className="truncate text-xs text-grey-60 dark:text-grey-dark-700">{s.userId}</span>
                  </>
                ) : s.kind === "emoji" ? (
                  <>
                    <span className="text-lg leading-none">{s.emoji.char}</span>
                    <span>:{s.emoji.name}:</span>
                  </>
                ) : (
                  <>
                    <span className="font-mono text-xs">
                      /{s.name} <span className="text-grey-60 dark:text-grey-dark-700">{s.args}</span>
                    </span>
                    <span className="ml-auto truncate text-xs text-grey-60 dark:text-grey-dark-700">{s.description}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => updateText(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onClick={() => setTrigger(triggerAt(text, textareaRef.current?.selectionStart ?? text.length))}
          onBlur={() => typing.stop()}
          rows={1}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[15px] leading-[1.45] text-grey-10 outline-none placeholder:text-grey-60 dark:text-grey-light-100 dark:placeholder:text-grey-dark-700"
        />

        <UploadList items={uploads} onCancel={(id) => setUploads((prev) => prev.filter((u) => (u.id === id ? (u.abort.abort(), false) : true)))} />

        <div className="flex items-center gap-0.5 px-1.5 pb-1.5 pt-1">
          <CustomTooltip tooltipContent="Bold (⌘B)" asChild>
            <button type="button" className={TOOL_BUTTON} aria-label="Bold" onClick={() => wrapSelection("*")}>
              <Bold className="size-4" aria-hidden />
            </button>
          </CustomTooltip>
          <CustomTooltip tooltipContent="Italic (⌘I)" asChild>
            <button type="button" className={TOOL_BUTTON} aria-label="Italic" onClick={() => wrapSelection("_")}>
              <Italic className="size-4" aria-hidden />
            </button>
          </CustomTooltip>
          <CustomTooltip tooltipContent="Strikethrough (⌘⇧X)" asChild>
            <button type="button" className={TOOL_BUTTON} aria-label="Strikethrough" onClick={() => wrapSelection("~")}>
              <Strikethrough className="size-4" aria-hidden />
            </button>
          </CustomTooltip>
          <CustomTooltip tooltipContent="Code (⌘E) — click twice for a block" asChild>
            <button
              type="button"
              className={TOOL_BUTTON}
              aria-label="Code"
              onClick={(e) => wrapSelection("`".repeat(e.detail >= 2 ? 3 : 1), e.detail >= 2)}
            >
              <Code className="size-4" aria-hidden />
            </button>
          </CustomTooltip>
          <span className="mx-1 h-4 w-px bg-grey-80 dark:bg-black-500" aria-hidden />
          <EmojiPicker
            quickRow={false}
            side="top"
            align="start"
            onPick={insertAtCaret}
            trigger={
              <button type="button" className={TOOL_BUTTON} aria-label="Insert emoji">
                <Smile className="size-4" aria-hidden />
              </button>
            }
          />
          <button type="button" className={TOOL_BUTTON} aria-label="Attach file" onClick={() => fileInputRef.current?.click()} disabled={Boolean(editing)}>
            <Paperclip className="size-4" aria-hidden />
          </button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFileInput} aria-hidden tabIndex={-1} />

          <span className="ml-auto hidden text-[11px] text-grey-60 sm:inline dark:text-grey-dark-700" aria-hidden>
            {editing ? "Enter to save · Esc to cancel" : "Enter to send · Shift+Enter for a new line"}
          </span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            aria-label={editing ? "Save changes" : "Send message"}
            className={cn(
              "ml-1 inline-flex size-7 items-center justify-center rounded-md transition-colors",
              canSend
                ? "bg-primary-50 text-white hover:opacity-90 dark:bg-primary-40 dark:text-white"
                : "text-grey-60 dark:text-grey-dark-700",
            )}
          >
            <SendHorizontal className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

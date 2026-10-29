"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import MiddleTruncate from "@/components/ui/MiddleTruncate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { shareCommentRepliesEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import {
  blockShareCommenter,
  deleteShareComment,
  listShareComments,
  unblockShareCommenter,
  type ShareComment,
  type ShareCommentMention,
  type ShareCommentReply,
  type ShareInsights,
} from "@/app/lib/tauri/shareInsights";
import { useIsOnline } from "@/app/lib/hooks/useIsOnline";
import { InsightsAvatar } from "./InsightsAvatar";
import { commentsQueryKey, insightsQueryKey, PANEL_MUTATION, PANEL_QUERY } from "./queryKeys";
import {
  actionErrorLine,
  BLOCK_EXPLAINER,
  COMMENTS_PAGE,
  DELETE_EXPLAINER,
  formatAgo,
  formatWatched,
  loadErrorLine,
  mentionSegments,
  sortThreads,
  threadsMentioningYou,
  viewerName,
  visibleReplies,
  type CommentOrder,
} from "./insightsView";
import { LoadError } from "./LoadError";
import { SwitchOffNotice } from "./LinkSettingsPopover";
import { DIVIDE, FLOATING, FOCUS, MUTED, SKELETON, STRONG, TEXT_LINK } from "./panelStyles";

/** Which question a comment row is asking, if any. */
type RowQuestion = { id: string; kind: "delete" | "block" } | null;

/**
 * The link's comments and what the owner does to them, held by the panel so
 * the summary's count and the Comments tab read one list, and a block lasts
 * while the panel is open.
 */
export function useCommentModeration(shareToken: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const comments = useQuery({
    queryKey: commentsQueryKey(shareToken),
    queryFn: () => listShareComments(shareToken),
    ...PANEL_QUERY,
    enabled,
  });
  const [asking, setAsking] = useState<RowQuestion>(null);
  // Comments whose author was blocked from this panel. The server keeps the
  // block but never lists it, so this is the only place it shows; it lasts
  // while the panel is open.
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const remove = useMutation({
    ...PANEL_MUTATION,
    mutationFn: (id: string) => deleteShareComment(shareToken, id),
    onSuccess: () => {
      setAsking(null);
      void queryClient.invalidateQueries({ queryKey: commentsQueryKey(shareToken) });
      void queryClient.invalidateQueries({ queryKey: insightsQueryKey(shareToken) });
    },
    onError: (err) => toast.error(actionErrorLine("delete the comment", err, navigator.onLine)),
  });
  const block = useMutation({
    ...PANEL_MUTATION,
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? blockShareCommenter(shareToken, id) : unblockShareCommenter(shareToken, id),
    onSuccess: (_, { id, on }) => {
      setAsking(null);
      setBlocked((prev) => {
        const next = new Set(prev);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
      toast.success(on ? "Blocked. They can't comment or react on this link now." : "Unblocked.");
    },
    onError: (err, { on }) => {
      toast.error(actionErrorLine(on ? "block them" : "unblock them", err, navigator.onLine));
      // A comment that is gone takes its row with it.
      void queryClient.invalidateQueries({ queryKey: commentsQueryKey(shareToken) });
    },
  });
  return { comments, asking, setAsking, blocked, remove, block };
}

export type Moderation = ReturnType<typeof useCommentModeration>;

/**
 * The Comments tab, built for a link with twenty or more: compact rows,
 * long comments clamped, replies folded past two, Newest or Oldest first,
 * and ten threads at a time.
 */
export function CommentsTab({
  moderation,
  plan,
  offLine,
  onTurnOn,
}: {
  moderation: Moderation;
  plan: ShareInsights["plan"] | null;
  /** Said above the list while the Comments switch is off. */
  offLine: string | null;
  onTurnOn: (from: HTMLElement) => void;
}) {
  const repliesEnabled = useAtomValue(shareCommentRepliesEnabledAtom);
  const online = useIsOnline();
  const { comments, asking, setAsking, blocked, remove, block } = moderation;
  const [order, setOrder] = useState<CommentOrder>("newest");
  const [limit, setLimit] = useState(COMMENTS_PAGE);
  const [onlyMentions, setOnlyMentions] = useState(false);
  const list = useMemo(() => comments.data?.comments ?? [], [comments.data]);
  const mentioning = useMemo(() => threadsMentioningYou(list), [list]);
  const filtering = onlyMentions && mentioning.length > 0;
  const sorted = useMemo(() => sortThreads(filtering ? mentioning : list, order), [filtering, mentioning, list, order]);
  const shown = sorted.slice(0, limit);

  return (
    <div>
      {offLine && <SwitchOffNotice line={offLine} onTurnOn={onTurnOn} />}
      {comments.isPending ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className={cn(SKELETON, "h-10")} />
          ))}
        </div>
      ) : comments.isError ? (
        <LoadError line={loadErrorLine("comments", comments.error, online)} onRetry={() => void comments.refetch()} />
      ) : (
        <>
          {comments.data.unreadable && <p className={cn("mb-2 text-sm", MUTED)}>{comments.data.unreadable}</p>}
          {list.length === 0 ? (
            <p className={cn("text-sm", MUTED)}>No comments yet.</p>
          ) : (
            <>
              <div className="mb-1 flex min-h-7 items-center justify-between gap-3">
                <p className={cn("min-w-0 truncate text-xs", MUTED)}>
                  {/* On the free plan comments are not locked: say so. */}
                  {plan === "free" ? "All included on your plan" : null}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {mentioning.length > 0 && (
                    <MentionsFilter
                      count={mentioning.length}
                      on={filtering}
                      onChange={(on) => {
                        setOnlyMentions(on);
                        setLimit(COMMENTS_PAGE);
                      }}
                    />
                  )}
                  {list.length > 1 && <SortToggle order={order} onChange={setOrder} />}
                </div>
              </div>
              <ul className={cn("flex flex-col divide-y", DIVIDE)} aria-label="Comments">
                {shown.map((c) => (
                  <CommentRow
                    key={c.id}
                    comment={c}
                    showReplies={repliesEnabled}
                    asking={asking?.id === c.id ? asking.kind : null}
                    blocked={blocked.has(c.id)}
                    busy={
                      (remove.isPending && remove.variables === c.id) ||
                      (block.isPending && block.variables?.id === c.id)
                    }
                    onAsk={(kind) => setAsking({ id: c.id, kind })}
                    onCancel={() => setAsking(null)}
                    onDelete={() => remove.mutate(c.id)}
                    onBlock={(on) => block.mutate({ id: c.id, on })}
                  />
                ))}
              </ul>
              {sorted.length > shown.length && (
                <div className="mt-2 flex items-center justify-between gap-3">
                  <button type="button" className={TEXT_LINK} onClick={() => setLimit((n) => n + COMMENTS_PAGE)}>
                    Show more comments
                  </button>
                  <span className={cn("text-xs tabular-nums", MUTED)}>
                    {shown.length} of {sorted.length}
                  </span>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** "Mentions you", once anyone has: shows only the threads that mention the owner. */
function MentionsFilter({ count, on, onChange }: { count: number; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid="mentions-filter"
      onClick={() => onChange(!on)}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors",
        FOCUS,
        on
          ? "border-[#e5c96a] bg-[#fff0c2] text-[#6b4700] dark:border-[#ffc933]/40 dark:bg-[#ffc933]/[0.18] dark:text-[#ffd666]"
          : cn("border-grey-80 hover:text-grey-10 dark:border-white/10 dark:hover:text-white", MUTED),
      )}
    >
      Mentions you
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

const MENTION_CHIP =
  "rounded-[4px] bg-primary-50/10 px-[3px] py-px font-medium text-primary-50 [box-decoration-break:clone] dark:bg-primary-50/20 dark:text-primary-brand-dark";
const MENTION_CHIP_YOU =
  "rounded-[4px] bg-[#fff0c2] px-[3px] py-px font-semibold text-[#6b4700] [box-decoration-break:clone] dark:bg-[#ffc933]/[0.18] dark:text-[#ffd666]";

/** A comment's text with its @mentions highlighted; a mention of the owner stands out. */
export function MentionText({ text, mentions }: { text: string; mentions?: readonly ShareCommentMention[] }) {
  if (!mentions || mentions.length === 0) return <>{text}</>;
  return (
    <>
      {mentionSegments(text, mentions).map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span
            key={i}
            data-mention={seg.mention.kind}
            data-mention-you={seg.mention.you ? "true" : undefined}
            title={seg.mention.kind === "owner" ? "The owner of this link" : undefined}
            className={seg.mention.you ? MENTION_CHIP_YOU : MENTION_CHIP}
          >
            <bdi>@{seg.mention.label}</bdi>
            {seg.mention.you && <span className="sr-only"> (you)</span>}
          </span>
        ),
      )}
    </>
  );
}

/** "Mentioned you" beside a comment that mentions the owner. */
function MentionedYou() {
  return (
    <span
      data-testid="mentioned-you"
      className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full bg-[#fff0c2] px-[7px] text-[11px] font-semibold text-[#6b4700] dark:bg-[#ffc933]/[0.18] dark:text-[#ffd666]"
    >
      Mentioned you
    </span>
  );
}

function SortToggle({ order, onChange }: { order: CommentOrder; onChange: (next: CommentOrder) => void }) {
  const options: Array<[CommentOrder, string]> = [
    ["newest", "Newest"],
    ["oldest", "Oldest"],
  ];
  return (
    <div role="group" aria-label="Sort comments" className="inline-flex shrink-0 rounded-[7px] bg-grey-90 p-0.5 dark:bg-white/[0.06]">
      {options.map(([value, label]) => {
        const active = order === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={cn(
              "h-6 rounded-[5px] px-2 text-[11.5px] font-medium transition-colors",
              FOCUS,
              active
                ? "bg-white text-grey-10 shadow-sm dark:bg-white/[0.12] dark:text-white"
                : cn(MUTED, "hover:text-grey-10 dark:hover:text-white"),
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** A person's name on one line, cut in the middle when it does not fit. */
export function PersonName({ name, muted = false, className }: { name: string | null; muted?: boolean; className?: string }) {
  return (
    <bdi className={cn("block min-w-0 overflow-hidden font-semibold", muted ? MUTED : STRONG, className)}>
      <MiddleTruncate text={viewerName(name)} kind="name" />
    </bdi>
  );
}

/**
 * Text clamped to four lines, with Show more when it is cut. Whether it is
 * cut is measured, so a short comment never carries the button.
 */
function ClampedText({
  text,
  mentions,
  className,
}: {
  text: string;
  mentions?: readonly ShareCommentMention[];
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);
  return (
    <>
      <p
        ref={ref}
        data-clamped-text=""
        className={cn("whitespace-pre-wrap break-words [overflow-wrap:anywhere]", !expanded && "line-clamp-4", className)}
      >
        <MentionText text={text} mentions={mentions} />
      </p>
      {(cut || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(TEXT_LINK, "mt-0.5 text-xs")}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

const MENU_ITEM = cn(
  "flex items-start gap-2.5 rounded-[8px] px-2.5 py-2 text-left",
  "hover:bg-grey-90 focus:bg-grey-90 dark:hover:bg-[#2a2a2a] dark:focus:bg-[#2a2a2a]",
);

function MomentChip({ atMs }: { atMs: number }) {
  return (
    <span className="shrink-0 rounded-[5px] bg-primary-50/10 px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none text-primary-50 dark:bg-primary-50/20 dark:text-primary-brand-dark">
      <span className="sr-only">at </span>
      {formatWatched(atMs)}
    </span>
  );
}

function When({ at }: { at: string }) {
  const date = new Date(at);
  return (
    <time
      dateTime={at}
      title={Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()}
      className={cn("shrink-0 whitespace-nowrap text-xs", MUTED)}
    >
      {formatAgo(at)}
    </time>
  );
}

function CommentRow({
  comment,
  showReplies,
  asking,
  blocked,
  busy,
  onAsk,
  onCancel,
  onDelete,
  onBlock,
}: {
  comment: ShareComment;
  /** Replies and the Owner badge, once the server has them (`share_comment_replies`). */
  showReplies: boolean;
  asking: "delete" | "block" | null;
  blocked: boolean;
  busy: boolean;
  onAsk: (kind: "delete" | "block") => void;
  onCancel: () => void;
  onDelete: () => void;
  onBlock: (on: boolean) => void;
}) {
  const name = viewerName(comment.name);
  // A menu choice opens the question in the row, whose button takes focus:
  // the menu must not pull focus back to its trigger as it closes.
  const chose = useRef(false);
  // When the question goes (answered or cancelled), its buttons go with it:
  // focus returns to the row's menu button rather than falling to the page.
  const trigger = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (wasAsking.current && asking === null) trigger.current?.focus();
    wasAsking.current = asking !== null;
  }, [asking]);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const replies = visibleReplies(showReplies ? (comment.replies ?? []) : [], repliesOpen);
  return (
    <li className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2 py-2.5" data-testid="comment-thread">
      <InsightsAvatar name={comment.name} size="row" className={blocked ? "opacity-50" : undefined} />
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5 leading-6">
          <PersonName name={comment.name} muted={blocked} className="text-[13px]" />
          {blocked ? (
            <span
              title="They can't comment or react on this link."
              className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-error-70/10 px-[7px] text-[11px] font-semibold text-error-70"
            >
              <Ban className="size-2.5" strokeWidth={2.5} aria-hidden />
              Blocked
            </span>
          ) : (
            <>
              {comment.atMs !== null && <MomentChip atMs={comment.atMs} />}
              <When at={comment.createdAt} />
              {comment.mentionsYou && <MentionedYou />}
            </>
          )}
        </p>
        {comment.text !== null ? (
          <ClampedText
            text={comment.text}
            mentions={comment.mentions}
            className={cn("text-[13px] leading-[1.45]", blocked ? MUTED : STRONG)}
          />
        ) : (
          <p className={cn("text-[13px] italic", MUTED)}>This comment couldn&apos;t be read.</p>
        )}
        {replies.shown.length > 0 && (
          <ul className="mt-2 flex flex-col gap-2" aria-label={`Replies to ${name}`}>
            {replies.shown.map((r) => (
              <ReplyRow key={r.id} reply={r} />
            ))}
          </ul>
        )}
        {replies.hidden > 0 && (
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setRepliesOpen(true)}
            className={cn(TEXT_LINK, "ml-7 mt-1.5 text-xs")}
          >
            Show {replies.hidden} more {replies.hidden === 1 ? "reply" : "replies"}
          </button>
        )}
        {asking && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-grey-30 dark:text-grey-dark-700">
              {asking === "delete"
                ? blocked
                  ? "Delete this comment for everyone? Its author stays blocked."
                  : "Delete this comment for everyone?"
                : "Block them on this link? They won't be able to comment or react here. Their comments stay until you delete them."}
            </span>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={asking === "delete" ? onDelete : () => onBlock(true)}
              autoFocus
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              {asking === "delete" ? "Delete" : "Block"}
            </Button>
            <Button variant="defaultStable" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      {!asking && (
        <div className="flex shrink-0 items-center gap-1">
          {blocked && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onBlock(false)}
              className={cn(TEXT_LINK, "h-6 px-1.5 disabled:opacity-50")}
            >
              Unblock
            </button>
          )}
          <DropdownMenu
            modal={false}
            onOpenChange={(open) => {
              if (open) chose.current = false;
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                ref={trigger}
                type="button"
                disabled={busy}
                aria-label={`Comment actions for ${name}`}
                className={cn(
                  "flex size-6 items-center justify-center rounded-[6px] transition-colors disabled:opacity-50",
                  MUTED,
                  "hover:bg-grey-90 data-[state=open]:bg-grey-90 data-[state=open]:text-grey-10",
                  "dark:hover:bg-[#2a2a2a] dark:data-[state=open]:bg-[#2a2a2a] dark:data-[state=open]:text-white",
                  FOCUS,
                )}
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              // Above the narrow-window sheet (z-1003) the panel is there.
              className={cn("z-[1010] w-[260px] p-1.5", FLOATING)}
              onCloseAutoFocus={(e) => {
                if (chose.current) e.preventDefault();
              }}
            >
              {!blocked && (
                <DropdownMenuItem
                  className={MENU_ITEM}
                  onSelect={() => {
                    chose.current = true;
                    onAsk("block");
                  }}
                >
                  <Ban className={cn("mt-0.5 size-4 shrink-0", STRONG)} aria-hidden />
                  <span className="flex min-w-0 flex-col">
                    <span className={cn("flex min-w-0 gap-1 text-[13px] font-medium", STRONG)}>
                      <span className="shrink-0">Block</span>
                      <bdi className="block min-w-0 overflow-hidden">
                        <MiddleTruncate text={name} kind="name" />
                      </bdi>
                    </span>
                    <span className={cn("text-[11.5px] leading-4", MUTED)}>{BLOCK_EXPLAINER}</span>
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className={MENU_ITEM}
                onSelect={() => {
                  chose.current = true;
                  onAsk("delete");
                }}
              >
                <Trash2 className="mt-0.5 size-4 shrink-0 text-error-70" aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-medium text-error-70">Delete comment</span>
                  <span className={cn("text-[11.5px] leading-4", MUTED)}>{DELETE_EXPLAINER}</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

function ReplyRow({ reply: r }: { reply: ShareCommentReply }) {
  return (
    <li className="grid grid-cols-[20px_minmax(0,1fr)] gap-2" data-testid="comment-reply">
      <InsightsAvatar name={r.name} size="sm" className="mt-0.5" />
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5 leading-5">
          <PersonName name={r.name} className="text-[12.5px]" />
          {r.byOwner && (
            <span className="shrink-0 text-[11px] font-semibold text-primary-50 dark:text-primary-brand-dark">Owner</span>
          )}
          <When at={r.createdAt} />
          {r.mentionsYou && <MentionedYou />}
        </p>
        {r.text !== null && (
          <ClampedText text={r.text} mentions={r.mentions} className={cn("text-[12.5px] leading-[1.45]", STRONG)} />
        )}
      </div>
    </li>
  );
}

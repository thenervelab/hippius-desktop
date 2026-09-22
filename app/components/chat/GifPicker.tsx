"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { useSetAtom } from "jotai";
import { Search } from "lucide-react";

import { chatMenuContentClassName } from "@/components/chat/ChatMenu";
import ChatTooltip from "@/components/chat/ChatTooltip";
import { gifsAvailabilityAtom } from "@/components/chat/chat-ui-atoms";
import {
  GIFS_DISABLED_MESSAGE,
  type GifPage,
  type GifResult,
  featuredGifs,
  gifErrorMessage,
  isGifsUnavailable,
  searchGifs,
} from "@/lib/chat/gifs-api";
import { cn } from "@/lib/utils";

const COLUMNS = 2;
const DEBOUNCE_MS = 300;
/** Content is `w-[320px] p-2` like the emoji picker; two tiles plus one gap. */
const TILE_WIDTH = (320 - 16 - 6) / COLUMNS;

interface GifPickerProps {
  trigger: ReactNode;
  onPick: (gif: GifResult) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * GIFs are not enabled on this deployment: the trigger is greyed out with
   * an explanation and does not open the picker. If the answer arrives while
   * the picker is already open (a page came back 503), the popover stays so
   * the user reads why; the trigger greys out once they close it.
   */
  disabled?: boolean;
  /** Pre-filled search (the `/gif <query>` command). Applied each time the picker opens. */
  initialQuery?: string;
  align?: "start" | "end" | "center";
  side?: "top" | "bottom";
}

type Feed =
  | { status: "loading"; results: GifResult[]; next: string | null }
  | { status: "ready"; results: GifResult[]; next: string | null }
  | {
      status: "error";
      results: GifResult[];
      next: string | null;
      message: string;
      retryable: boolean;
    };

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * GIF picker on the emoji picker's popover: search with a 300 ms debounce
 * ("Trending" while empty), a two-column grid of animated previews that
 * only load and animate while on screen, infinite scroll through the
 * proxy's cursor, arrow-key navigation, Enter to pick, Esc to close.
 * Search goes through Rust to the backend proxy; the webview never calls
 * the GIF provider for search. The footer shows the provider's attribution
 * exactly as the proxy sends it.
 */
export default function GifPicker({
  trigger,
  onPick,
  open,
  onOpenChange,
  disabled = false,
  initialQuery = "",
  align = "start",
  side = "top",
}: GifPickerProps) {
  const setAvailability = useSetAtom(gifsAvailabilityAtom);

  const [query, setQuery] = useState(initialQuery);
  const debouncedQuery = useDebounced(query.trim(), DEBOUNCE_MS);
  const [feed, setFeed] = useState<Feed>({
    status: "loading",
    results: [],
    next: null,
  });
  /** Bumped by Retry: re-runs the first-page fetch for the current query. */
  const [attempt, setAttempt] = useState(0);
  /** Last attribution the proxy sent; kept across reloads so the footer does not blink. */
  const [attribution, setAttribution] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const requestSeq = useRef(0);
  const loadingMore = useRef(false);

  // Each opening starts from the caller's query (the slash command) or empty.
  useEffect(() => {
    if (open) setQuery(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fetchPage = useCallback(
    (q: string, pos: string | null): Promise<GifPage> =>
      q ? searchGifs(q, { pos }) : featuredGifs({ pos }),
    [],
  );

  // First page for the current query.
  useEffect(() => {
    if (!open) return;
    const seq = ++requestSeq.current;
    setFeed({ status: "loading", results: [], next: null });
    setActive(0);
    fetchPage(debouncedQuery, null)
      .then((page) => {
        if (seq !== requestSeq.current) return;
        setAvailability("ready");
        if (page.attribution) setAttribution(page.attribution);
        setFeed({ status: "ready", results: page.results, next: page.next });
      })
      .catch((error: unknown) => {
        if (seq !== requestSeq.current) return;
        const unavailable = isGifsUnavailable(error);
        if (unavailable) setAvailability("disabled");
        setFeed({
          status: "error",
          results: [],
          next: null,
          message: gifErrorMessage(error),
          retryable: !unavailable,
        });
      });
  }, [open, debouncedQuery, attempt, fetchPage, setAvailability]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const loadMore = useCallback(() => {
    if (feed.status !== "ready" || !feed.next || loadingMore.current) return;
    loadingMore.current = true;
    const seq = requestSeq.current;
    const q = debouncedQuery;
    fetchPage(q, feed.next)
      .then((page) => {
        if (seq !== requestSeq.current) return;
        if (page.attribution) setAttribution(page.attribution);
        setFeed((prev) => {
          const seen = new Set(prev.results.map((r) => r.id));
          return {
            status: "ready",
            results: [
              ...prev.results,
              ...page.results.filter((r) => !seen.has(r.id)),
            ],
            next: page.next,
          };
        });
      })
      .catch(() => {
        // Keep what we have; the sentinel will retry when it scrolls back in.
      })
      .finally(() => {
        loadingMore.current = false;
      });
  }, [feed, debouncedQuery, fetchPage]);

  const pick = (gif: GifResult) => {
    onPick(gif);
    onOpenChange(false);
  };

  const results = feed.results;
  const canRetry = feed.status === "error" && feed.retryable;

  // Radix menus swallow Tab, so the arrow keys are the only way between the
  // search field and what sits below it: the grid, or the Retry button when
  // a page failed. The empty list is then not a focus stop of its own.
  const focusBelowInput = () => {
    if (canRetry) retryRef.current?.focus();
    else if (results.length) gridRef.current?.focus();
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
      return;
    }
    const max = results.length - 1;
    if (event.key === "ArrowUp" && (max < 0 || active < COLUMNS)) {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    // Nothing to navigate: leave Enter and Space to the focused Retry button.
    if (max < 0) return;
    let next = active;
    if (event.key === "ArrowRight") next = Math.min(max, active + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, active - 1);
    else if (event.key === "ArrowDown") next = Math.min(max, active + COLUMNS);
    else if (event.key === "ArrowUp") next = active - COLUMNS;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (results[active]) pick(results[active]);
      return;
    } else return;
    event.preventDefault();
    setActive(next);
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-index="${next}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
    if (next >= results.length - COLUMNS * 2) loadMore();
  };

  // Split into columns by alternation so arrow keys stay predictable:
  // ↓ is +2, → is +1. Small previews are of similar heights, so this reads
  // as a masonry without a layout pass.
  const columns = useMemo(() => {
    const cols: { gif: GifResult; index: number }[][] = Array.from(
      { length: COLUMNS },
      () => [],
    );
    results.forEach((gif, index) => cols[index % COLUMNS].push({ gif, index }));
    return cols;
  }, [results]);

  // Swap the trigger for its greyed-out twin only while closed: re-wrapping
  // it under an open popover would remount the anchor mid-display.
  const greyed = disabled && !open;

  return (
    <Dropdown.Root open={open} onOpenChange={onOpenChange} modal={false}>
      {greyed ? (
        // A disabled button emits no pointer events, so the tooltip listens
        // on a wrapper the pointer does reach.
        <ChatTooltip tooltipContent={GIFS_DISABLED_MESSAGE}>
          <span className="inline-flex" data-testid="gif-trigger-disabled">
            <Dropdown.Trigger asChild disabled>
              {trigger}
            </Dropdown.Trigger>
          </span>
        </ChatTooltip>
      ) : (
        <Dropdown.Trigger asChild disabled={disabled}>
          {trigger}
        </Dropdown.Trigger>
      )}
      <Dropdown.Portal>
        <Dropdown.Content
          align={align}
          side={side}
          sideOffset={6}
          className={cn(chatMenuContentClassName, "w-[320px] p-2")}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Radix menus steal typeahead keys; we own the keyboard inside.
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="GIF picker"
        >
          <div className="mb-2 flex h-8 items-center gap-1.5 rounded-md border border-grey-80 bg-grey-light-600 px-2 dark:border-black-300 dark:bg-black-primary-bg">
            <Search
              className="size-3.5 shrink-0 text-grey-60 dark:text-grey-dark-700"
              aria-hidden
            />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "Enter") {
                  e.preventDefault();
                  focusBelowInput();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onOpenChange(false);
                }
              }}
              placeholder="Search GIFs"
              aria-label="Search GIFs"
              className="min-w-0 flex-1 bg-transparent text-xs text-grey-10 outline-none placeholder:text-grey-60 dark:text-grey-light-100 dark:placeholder:text-grey-dark-700"
            />
          </div>

          <p className="mb-1 px-0.5 text-[11px] font-medium uppercase tracking-wide text-grey-60 dark:text-grey-dark-700">
            {debouncedQuery ? `Results for “${debouncedQuery}”` : "Trending"}
          </p>

          <GifGrid
            gridRef={gridRef}
            retryRef={retryRef}
            columns={columns}
            active={active}
            feed={feed}
            onKeyDown={onGridKey}
            onHover={setActive}
            onPick={pick}
            onEndReached={loadMore}
            onRetry={retry}
          />

          <p className="mt-1.5 flex items-center justify-between px-0.5 text-[11px] text-grey-60 dark:text-grey-dark-700">
            <span className="truncate">{results[active]?.title ?? ""}</span>
            {attribution ? (
              <span className="shrink-0 pl-2" data-testid="gif-attribution">
                {attribution}
              </span>
            ) : null}
          </p>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

// ---------------------------------------------------------------------------

interface GifGridProps {
  gridRef: RefObject<HTMLDivElement | null>;
  /** The Retry button of a failed page; the keyboard route from the search field lands on it. */
  retryRef: RefObject<HTMLButtonElement | null>;
  columns: { gif: GifResult; index: number }[][];
  active: number;
  feed: Feed;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onHover: (index: number) => void;
  onPick: (gif: GifResult) => void;
  onEndReached: () => void;
  onRetry: () => void;
}

/**
 * The scrolling grid. One IntersectionObserver rooted on the scroller tells
 * each tile whether it is on screen: off-screen tiles drop their `<img>` so
 * the webview neither downloads nor animates them. A sentinel at the end
 * asks for the next page.
 */
function GifGrid({
  gridRef: ref,
  retryRef,
  columns,
  active,
  feed,
  onKeyDown,
  onHover,
  onPick,
  onEndReached,
  onRetry,
}: GifGridProps) {
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const observer = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasObserver = typeof IntersectionObserver !== "undefined";

  useEffect(() => {
    const root = ref.current;
    if (!root || !hasObserver) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset.gifId;
            if (!id) continue;
            if (entry.isIntersecting) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      },
      { root, rootMargin: "120px 0px" },
    );
    observer.current = io;
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, [ref, hasObserver]);

  useEffect(() => {
    const root = ref.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasObserver) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onEndReached();
      },
      { root, rootMargin: "200px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [ref, hasObserver, onEndReached, feed.results.length]);

  const register = useCallback((el: HTMLElement | null) => {
    if (el) observer.current?.observe(el);
  }, []);

  const empty = feed.status === "ready" && feed.results.length === 0;
  const canRetry = feed.status === "error" && feed.retryable;

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="GIFs"
      aria-busy={feed.status === "loading"}
      // While Retry is shown it is the focus stop; the empty list steps aside.
      tabIndex={canRetry ? -1 : 0}
      onKeyDown={onKeyDown}
      className="max-h-[320px] overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-primary-50 dark:focus-visible:ring-primary-40"
    >
      {feed.status === "error" ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-2 py-8 text-center text-xs text-grey-60 dark:text-grey-dark-700"
        >
          <p>{feed.message}</p>
          {feed.retryable ? (
            <button
              ref={retryRef}
              type="button"
              onClick={onRetry}
              className="rounded-md border border-grey-80 px-2 py-1 text-xs font-medium text-grey-10 outline-none hover:bg-grey-90 focus-visible:ring-2 focus-visible:ring-primary-50 dark:border-black-300 dark:text-grey-light-100 dark:hover:bg-black-500 dark:focus-visible:ring-primary-40"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : empty ? (
        <p className="py-8 text-center text-xs text-grey-60 dark:text-grey-dark-700">
          No GIFs match
        </p>
      ) : feed.status === "loading" && feed.results.length === 0 ? (
        <div className="grid grid-cols-2 gap-1.5" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="animate-pulse rounded-md bg-grey-90 dark:bg-black-500"
              style={{ height: i % 3 === 0 ? 120 : 90 }}
            />
          ))}
        </div>
      ) : (
        <div className="flex gap-1.5">
          {columns.map((column, c) => (
            <div key={c} className="flex min-w-0 flex-1 flex-col gap-1.5">
              {column.map(({ gif, index }) => (
                <GifTile
                  key={gif.id}
                  gif={gif}
                  index={index}
                  selected={index === active}
                  visible={!hasObserver || visible.has(gif.id)}
                  register={register}
                  onHover={() => onHover(index)}
                  onPick={() => onPick(gif)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={sentinelRef} className="h-px" aria-hidden />
    </div>
  );
}

interface GifTileProps {
  gif: GifResult;
  index: number;
  selected: boolean;
  visible: boolean;
  register: (el: HTMLElement | null) => void;
  onHover: () => void;
  onPick: () => void;
}

function GifTile({
  gif,
  index,
  selected,
  visible,
  register,
  onHover,
  onPick,
}: GifTileProps) {
  const ratio =
    gif.preview.width && gif.preview.height
      ? gif.preview.width / gif.preview.height
      : 1.5;
  const height = Math.max(48, Math.min(240, Math.round(TILE_WIDTH / ratio)));
  return (
    <button
      ref={register}
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={gif.title || "GIF"}
      title={gif.title}
      data-index={index}
      data-gif-id={gif.id}
      onMouseEnter={onHover}
      onClick={onPick}
      style={{ height }}
      className={cn(
        "relative block w-full overflow-hidden rounded-md bg-grey-90 outline-none dark:bg-black-500",
        selected && "ring-2 ring-primary-50 dark:ring-primary-40",
      )}
    >
      {visible ? (
        <img
          src={gif.preview.url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-cover"
        />
      ) : null}
    </button>
  );
}

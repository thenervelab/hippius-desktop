import { invoke } from "@tauri-apps/api/core";
import type {
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from "hls.js";

// hls.js normally fetches a playlist and its segments over HTTP. A converted
// preview is not on any server: Rust converts each segment on request
// (`video_preview_segment`, `video_engine/`). This loader turns hls.js's
// requests for `hippius-video://<session>/<name>` into that IPC call, so no
// network origin, CORS header or CSP change is involved.

const SCHEME = "hippius-video://";

/** The session and file a stream URL names, or `null` for any other URL. */
export function parseStreamUrl(url: string): { sessionId: string; name: string } | null {
  if (!url.startsWith(SCHEME)) return null;
  const rest = url.slice(SCHEME.length).split(/[?#]/)[0] ?? "";
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const sessionId = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (!name || name.includes("/")) return null;
  return { sessionId, name };
}

function emptyStats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

export class IpcLoader implements Loader<LoaderContext> {
  context: LoaderContext | null = null;
  stats: LoaderStats = emptyStats();
  private aborted = false;

  destroy(): void {
    this.aborted = true;
    this.context = null;
  }

  abort(): void {
    this.aborted = true;
    this.stats.aborted = true;
  }

  load(
    context: LoaderContext,
    _config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    this.context = context;
    this.aborted = false;
    const stats = emptyStats();
    this.stats = stats;
    stats.loading.start = performance.now();
    const target = parseStreamUrl(context.url);
    if (!target) {
      callbacks.onError({ code: 400, text: "Not a preview stream" }, context, null, stats);
      return;
    }
    invoke<ArrayBuffer>("video_preview_segment", target)
      .then((data) => {
        if (this.aborted) return;
        const now = performance.now();
        stats.loading.first = now;
        stats.loading.end = now;
        stats.loaded = data.byteLength;
        stats.total = data.byteLength;
        const payload =
          context.responseType === "arraybuffer" ? data : new TextDecoder().decode(data);
        callbacks.onSuccess({ url: context.url, data: payload, code: 200 }, stats, context, null);
      })
      .catch((err: unknown) => {
        if (this.aborted) return;
        const text =
          typeof err === "object" && err && "message" in err
            ? String((err as { message: unknown }).message)
            : String(err);
        // NotFound (past the end, closed) is a 404; anything else a 500,
        // which hls.js retries before it gives up.
        const kind = typeof err === "object" && err && "kind" in err ? (err as { kind: unknown }).kind : null;
        callbacks.onError({ code: kind === "NotFound" ? 404 : 500, text }, context, null, stats);
      });
  }
}

/** hls.js settings for a converted preview. */
export const HLS_PREVIEW_CONFIG: Partial<HlsConfig> = {
  loader: IpcLoader,
  // Rust converts ahead of the player on its own; a long buffer here would
  // only ask it to run further ahead.
  maxBufferLength: 20,
  backBufferLength: 30,
  enableWorker: true,
  lowLatencyMode: false,
};

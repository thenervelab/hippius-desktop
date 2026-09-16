import { useInvokeQuery } from "./useInvokeQuery";

/**
 * The account's uploads, summarised two ways by hcfs-server.
 *
 * Both are counters the server already keeps, so neither walks the drive.
 * They back the Overview's two breakdown cards, the same pair the console
 * shows on its Drive page.
 */

/** Raw counts per coarse category, as Rust returns them. */
export interface FileTypeSummary {
  image: number;
  video: number;
  audio: number;
  document: number;
  pdf: number;
  archive: number;
  code: number;
  other: number;
}

/**
 * The four buckets the chart draws, folded from the server's eight.
 *
 * The server reports a finer taxonomy than a four-colour chart can show, so
 * the fold happens once, here, rather than in the component: `docs` is
 * documents plus PDFs (a PDF is a document to everyone but a MIME table),
 * and `others` sweeps up audio, archives, code and the server's own catch-all.
 */
export interface FileTypeBuckets {
  images: number;
  videos: number;
  docs: number;
  others: number;
  total: number;
}

export const FILE_TYPE_SUMMARY_QUERY_KEY = "file-type-summary";
export const SOURCE_SUMMARY_QUERY_KEY = "source-summary";

export function foldFileTypes(s: FileTypeSummary): FileTypeBuckets {
  const images = s.image ?? 0;
  const videos = s.video ?? 0;
  const docs = (s.document ?? 0) + (s.pdf ?? 0);
  const others = (s.audio ?? 0) + (s.archive ?? 0) + (s.code ?? 0) + (s.other ?? 0);
  return { images, videos, docs, others, total: images + videos + docs + others };
}

export function useFileTypeSummary() {
  return useInvokeQuery<FileTypeSummary, FileTypeBuckets>({
    command: "get_file_type_summary",
    queryKey: (addr) => [FILE_TYPE_SUMMARY_QUERY_KEY, addr],
    options: { staleTime: 60_000, select: foldFileTypes },
  });
}

/** Per-client counts and their plaintext byte totals. */
export interface SourceSummary {
  desktop: number;
  desktop_bytes: number;
  console: number;
  console_bytes: number;
  mobile: number;
  mobile_bytes: number;
  other: number;
  other_bytes: number;
}

export interface SourceBuckets {
  desktop: number;
  console: number;
  mobile: number;
  other: number;
  total: number;
}

export function foldSources(s: SourceSummary): SourceBuckets {
  const desktop = s.desktop ?? 0;
  const consoleCount = s.console ?? 0;
  const mobile = s.mobile ?? 0;
  const other = s.other ?? 0;
  return {
    desktop,
    console: consoleCount,
    mobile,
    other,
    total: desktop + consoleCount + mobile + other,
  };
}

export function useSourceSummary() {
  return useInvokeQuery<SourceSummary, SourceBuckets>({
    command: "get_source_summary",
    queryKey: (addr) => [SOURCE_SUMMARY_QUERY_KEY, addr],
    options: { staleTime: 60_000, select: foldSources },
  });
}

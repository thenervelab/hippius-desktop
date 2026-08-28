"use client";

import { useCallback, type ReactNode } from "react";

import { MAX_STRUCTURED_TEXT_PREVIEW_BYTES } from "@/app/lib/utils/filePreviewType";

import { PreviewEmpty, PreviewError, PreviewLoading } from "./PreviewState";
import { PreviewCard, PreviewPane } from "./PreviewSurface";
import { usePreviewResource } from "./usePreviewResource";

const JSON_TOKEN_PATTERN =
  /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g;

/**
 * Re-serialise the file with a two-space indent.
 *
 * Round-tripping through `JSON.parse` is what makes a minified file readable,
 * and it is also the validity check: invalid JSON throws here and surfaces as
 * the graceful "not valid JSON" state instead of a wall of unparsed text.
 */
export function formatJsonPreview(bytes: Uint8Array): string {
  const source = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trim();
  if (!source) return "";
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    throw new Error("This file does not contain valid JSON.");
  }
}

function highlightedLine(line: string): ReactNode[] {
  const content: ReactNode[] = [];
  let offset = 0;

  for (const [index, match] of Array.from(
    line.matchAll(JSON_TOKEN_PATTERN),
  ).entries()) {
    if (match.index > offset) content.push(line.slice(offset, match.index));
    const value = match[0];
    const className = match[1]
      ? "text-[#1967d2] dark:text-[#8ab4f8]"
      : match[2]
        ? "text-[#188038] dark:text-[#81c995]"
        : match[3]
          ? "text-[#c5221f] dark:text-[#f28b82]"
          : match[4]
            ? "text-[#9334e6] dark:text-[#c58af9]"
            : "text-grey-50 dark:text-grey-light-300";
    content.push(
      <span key={`${match.index}-${index}`} className={className}>
        {value}
      </span>,
    );
    offset = match.index + value.length;
  }

  if (offset < line.length) content.push(line.slice(offset));
  return content;
}

/** JSON rendered indented, line-numbered and token-coloured. */
export default function JsonPreview({ localPath }: { localPath: string }) {
  const parse = useCallback(formatJsonPreview, []);
  const state = usePreviewResource(
    localPath,
    MAX_STRUCTURED_TEXT_PREVIEW_BYTES,
    parse,
  );

  if (state.status === "loading") {
    return <PreviewLoading title="Loading JSON preview…" />;
  }
  if (state.status === "error") {
    return (
      <PreviewError
        title="Couldn't preview this JSON file"
        description={state.message}
      />
    );
  }
  if (!state.data) {
    return <PreviewEmpty title="This JSON file is empty" />;
  }

  return (
    <PreviewPane>
      <PreviewCard className="mx-auto max-w-5xl">
        <div className="min-h-0 flex-1 select-text overflow-auto py-2 font-mono text-[13px] leading-6 text-grey-10 dark:text-grey-light-100">
          {state.data.split("\n").map((line, index) => (
            <div key={index} className="flex min-w-max">
              <span
                aria-hidden="true"
                className="sticky left-0 w-12 shrink-0 select-none border-r border-grey-dark-100 bg-white pr-3 text-right text-grey-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-light-300"
              >
                {index + 1}
              </span>
              <code className="whitespace-pre px-4">
                {line ? highlightedLine(line) : " "}
              </code>
            </div>
          ))}
        </div>
      </PreviewCard>
    </PreviewPane>
  );
}

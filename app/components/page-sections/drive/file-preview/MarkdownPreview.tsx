"use client";

import React, { useCallback } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MAX_TEXT_PREVIEW_BYTES } from "@/app/lib/utils/filePreviewType";

import { PreviewEmpty, PreviewError, PreviewLoading } from "./PreviewState";
import { PreviewCard, PreviewPane } from "./PreviewSurface";
import { decodePlainText } from "./PlainTextPreview";
import { usePreviewResource } from "./usePreviewResource";

/**
 * Renderers for the Markdown AST.
 *
 * Raw HTML embedded in the Markdown stays inert because `rehype-raw` is
 * deliberately **not** installed: without it, react-markdown emits the raw
 * block as text rather than parsing it into live DOM. Do not add it — a
 * synced `.md` file is untrusted content rendered inside the main WebView.
 */
const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-3 mt-6 border-b border-grey-dark-100 pb-2 text-2xl font-semibold first:mt-0 dark:border-black-300">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-6 text-xl font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-5 text-lg font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-2 mt-4 text-sm font-semibold first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-2 mt-4 text-sm font-semibold text-grey-50 first:mt-0 dark:text-grey-light-300">
      {children}
    </h6>
  ),
  p: ({ children }) => <p className="mb-3 leading-relaxed">{children}</p>,
  // Only http(s) and mailto links stay clickable; anything else (notably
  // `javascript:`) is flattened to plain text.
  a: ({ children, href }) =>
    !href || !/^(https?:|mailto:)/i.test(href) ? (
      <span>{children}</span>
    ) : (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-50 underline underline-offset-2 hover:opacity-80"
      >
        {children}
      </a>
    ),
  ul: ({ children, className }) => (
    <ul
      className={`mb-3 space-y-1 pl-6 ${
        className?.includes("contains-task-list") ? "" : "list-disc"
      }`}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-6">{children}</ol>
  ),
  li: ({ children, className }) => (
    <li
      className={`leading-relaxed ${
        className?.includes("task-list-item") ? "list-none" : ""
      }`}
    >
      {children}
    </li>
  ),
  input: ({ type, checked }) =>
    type === "checkbox" ? (
      <input
        type="checkbox"
        checked={checked === true}
        readOnly
        disabled
        className="mr-1.5 size-3.5 translate-y-px accent-primary-50"
      />
    ) : null,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-grey-dark-100 pl-4 text-grey-50 dark:border-black-300 dark:text-grey-light-300">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => (
    <code
      className={`rounded bg-grey-light-300 px-1 py-0.5 font-mono text-[0.85em] dark:bg-black-300 ${className ?? ""}`}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded border border-grey-dark-100 bg-grey-light-300 p-3 text-sm dark:border-black-300 dark:bg-black-300 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-6 border-grey-dark-100 dark:border-black-300" />,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-grey-dark-100 bg-grey-light-300 px-3 py-1.5 text-left font-semibold dark:border-black-300 dark:bg-black-300">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-grey-dark-100 px-3 py-1.5 dark:border-black-300">
      {children}
    </td>
  ),
  // Images resolve against no base, so only inline `data:` images can load.
  // A remote `src` simply fails to fetch; it is never a tracking beacon the
  // preview fires on the user's behalf.
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      className="my-3 max-w-full rounded"
    />
  ),
};

/** Renders already-decoded Markdown text. Exported for direct unit testing. */
export const MarkdownBody = React.memo(function MarkdownBody({
  text,
}: {
  text: string;
}) {
  return (
    <div className="select-text text-sm text-grey-10 dark:text-grey-light-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** MD / Markdown rendered as formatted prose on the shared document card. */
export default function MarkdownPreview({ localPath }: { localPath: string }) {
  const parse = useCallback(decodePlainText, []);
  const state = usePreviewResource(localPath, MAX_TEXT_PREVIEW_BYTES, parse);

  if (state.status === "loading") {
    return <PreviewLoading title="Loading Markdown preview…" />;
  }
  if (state.status === "error") {
    return (
      <PreviewError
        title="Couldn't preview this Markdown file"
        description={state.message}
      />
    );
  }
  if (state.data.trim().length === 0) {
    return <PreviewEmpty title="This Markdown file is empty" />;
  }

  return (
    <PreviewPane scroll>
      <PreviewCard className="mx-auto h-auto max-w-3xl flex-none px-6 py-5">
        <MarkdownBody text={state.data} />
      </PreviewCard>
    </PreviewPane>
  );
}

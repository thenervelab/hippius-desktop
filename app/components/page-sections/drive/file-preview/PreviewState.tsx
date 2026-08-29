"use client";

import React from "react";
import { AlertCircle, ExternalLink, FileQuestion, Loader2 } from "lucide-react";

import { Icons } from "@/components/ui";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { cn } from "@/lib/utils";

/**
 * The shared loading / empty / error / fallback states for every preview body.
 *
 * They live in one place so the viewer looks the same whichever renderer is
 * mounted: before this, each dialog drew its own spinner and its own error
 * card, and they disagreed on colour, size and wording.
 */

export function PreviewLoading({ title }: { title: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-grey-10 dark:text-grey-light-100"
    >
      <Loader2 className="size-6 animate-spin text-primary-50" />
      <p className="text-sm">{title}</p>
    </div>
  );
}

export function PreviewEmpty({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-grey-50 dark:text-grey-light-300">
      <FileQuestion className="size-7" />
      <p className="text-sm font-medium text-grey-10 dark:text-grey-light-100">
        {title}
      </p>
      {description ? <p className="max-w-md text-xs">{description}</p> : null}
    </div>
  );
}

const ACTION_PRIMARY_CLASS =
  "flex items-center gap-x-2 whitespace-nowrap rounded-md bg-primary-50 px-4 py-2 font-medium text-white transition-colors hover:bg-primary-70";
const ACTION_SECONDARY_CLASS =
  "flex items-center gap-x-2 whitespace-nowrap rounded-md bg-grey-10 px-4 py-2 font-medium text-white transition-colors hover:bg-grey-20 dark:bg-grey-20 dark:hover:bg-grey-30";

/**
 * The one error surface for a preview that cannot be shown, always carrying
 * the download escape hatch.
 *
 * Used for four causes that are indistinguishable to the user and want the
 * same affordance: the format has no renderer, the file is over its byte cap,
 * the bytes could not be read, or the renderer rejected the file as corrupt.
 * `onOpenExternally` is added only where a system viewer genuinely helps (the
 * Linux PDF path).
 */
export function PreviewFallback({
  title,
  description,
  file,
  handleFileDownload,
  onOpenExternally,
  icon,
}: {
  title: string;
  description?: string;
  file: FormattedUserFile;
  handleFileDownload: (file: FormattedUserFile, polkadotAddress: string) => void;
  onOpenExternally?: () => void;
  icon?: React.ReactNode;
}) {
  const { polkadotAddress } = useWalletAuth();

  return (
    <div
      role="alert"
      className={cn(
        "mx-auto flex w-full max-w-xl flex-col items-center justify-center rounded-[12px] p-6 text-center",
        "border border-grey-dark-100 bg-white/80 backdrop-blur-sm",
        "text-grey-10 dark:border-black-300 dark:bg-black-primary-bg/80 dark:text-grey-light-100",
      )}
    >
      {icon ?? <AlertCircle className="mx-auto mb-3 size-12 text-red-400" />}
      <p className="mb-2 text-lg font-medium">{title}</p>
      {description ? (
        <p className="mb-6 text-sm text-grey-50 dark:text-grey-light-300">
          {description}
        </p>
      ) : (
        <div className="mb-6" />
      )}
      <div className="flex flex-row flex-nowrap gap-3">
        {onOpenExternally ? (
          <button
            type="button"
            onClick={onOpenExternally}
            className={ACTION_PRIMARY_CLASS}
          >
            <ExternalLink className="size-5" />
            <span>Open with System Viewer</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => handleFileDownload(file, polkadotAddress ?? "")}
          className={onOpenExternally ? ACTION_SECONDARY_CLASS : ACTION_PRIMARY_CLASS}
        >
          <Icons.DocumentDownload className="size-5" />
          <span>Download File</span>
        </button>
      </div>
    </div>
  );
}

/**
 * In-pane error for a renderer that loaded but could not display the file.
 * Unlike `PreviewFallback` this has no actions — the viewer's own toolbar
 * still offers Download — so it is used where the pane is one of several
 * (a single unreadable sheet, a slide that failed to paint).
 */
export function PreviewError({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-grey-50 dark:text-grey-light-300"
    >
      <AlertCircle className="size-7 text-red-400" />
      <p className="text-sm font-medium text-grey-10 dark:text-grey-light-100">
        {title}
      </p>
      {description ? <p className="max-w-md text-xs">{description}</p> : null}
    </div>
  );
}

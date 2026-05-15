// Renders `NameCell` across the four sync-status states that map to a
// visible icon (`uploading`, `pending`, `downloading`, `failed`) and pins:
//
// 1. Only the icon for the active state is in the DOM.
// 2. The `failed` icon is a settled (non-pulsing) red AlertCircle — distinct
//    from the in-flight upload spinner. This is the visual seam the 402
//    fix relies on: a row stuck on `failed` must not keep masquerading as
//    `uploading` (the pre-fix bug).
// 3. `failed` reports an accessible `aria-label="Upload failed"` for AT.
//
// We don't exercise the row enricher here — that's covered by integration
// tests against `files-table/index.tsx`. This file pins the icon-switch
// contract that the enricher depends on.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import NameCell from "./NameCell";

// `next/link` reaches for the router context; replacing it with a plain
// `<a>` keeps the icon rendering pure and avoids dragging the App Router
// shim into a leaf-component test.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string | { pathname: string };
  } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : href.pathname} {...rest}>
      {children}
    </a>
  ),
}));

// `useUrlParams` reads from `useSearchParams`/`usePathname` — both unavailable
// in jsdom without a Next Router. The cell only uses the parameter values
// for folder navigation, which is orthogonal to the icon assertion.
vi.mock("@/app/utils/hooks/useUrlParams", () => ({
  useUrlParams: () => ({
    getParam: (_key: string, fallback: string) => fallback,
  }),
}));

// `SharedLinkBadge` does its own atom + Tauri-IPC dance. The icon under
// test sits next to it but doesn't depend on it; stubbing keeps the test
// hermetic.
vi.mock("@/components/page-sections/files/SharedLinkBadge", () => ({
  default: () => null,
}));

// Stub the file-type icon to a no-op so we don't pull in the full
// `getFileIcon` table — the row's leading icon isn't what we're asserting.
vi.mock("@/lib/utils/fileTypeUtils", () => ({
  getFileIcon: () => ({
    icon: ({ className }: { className?: string }) => (
      <span data-testid="file-icon" className={className} />
    ),
    color: "text-grey-50",
  }),
}));

// `MiddleTruncatedName` renders the suffix slot (where the sync-status icon
// lives) inside a span. We pass the suffix through unchanged so the icon is
// reachable via testing-library queries.
vi.mock("@/components/ui/MiddleTruncatedName", () => ({
  default: ({
    name,
    suffix,
  }: {
    name: string;
    suffix?: React.ReactNode;
  }) => (
    <span>
      {name}
      {suffix}
    </span>
  ),
}));

const baseProps = {
  rawName: "photo.jpg",
  actualName: "photo.jpg",
  arionHash: "0xdeadbeef",
  isAssigned: true,
  isFolder: false,
};

describe("NameCell sync-status icon", () => {
  it("renders a non-pulsing red AlertCircle with the 'Upload failed' label when syncStatus is 'failed'", () => {
    render(<NameCell {...baseProps} syncStatus="failed" />);

    const failedIcon = screen.getByTestId("sync-status-failed");
    expect(failedIcon).toBeInTheDocument();
    expect(failedIcon).toHaveAttribute("aria-label", "Upload failed");
    // The pulse is reserved for in-flight states; a settled failure must be
    // visually static so users can tell it isn't recovering on its own.
    // (SVG `className` is an `SVGAnimatedString`, not a plain string —
    // `toHaveClass` handles both; `getAttribute("class")` would also work.)
    expect(failedIcon).not.toHaveClass("animate-pulse");
    expect(failedIcon).toHaveClass("text-error-70");
  });

  // Each non-failed state pins BOTH halves: failed icon absent AND the
  // expected icon for that state present. Without the positive assertion a
  // future refactor that made `SyncStatusIcon` return `null` unconditionally
  // would let all four negative tests pass while regressing the entire row.
  it("routes 'uploading' to the uploading icon, not the failed icon", () => {
    render(<NameCell {...baseProps} syncStatus="uploading" />);

    expect(screen.queryByTestId("sync-status-failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-status-uploading")).toBeInTheDocument();
  });

  it("routes 'downloading' to the downloading icon, not the failed icon", () => {
    render(<NameCell {...baseProps} syncStatus="downloading" />);

    expect(screen.queryByTestId("sync-status-failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-status-downloading")).toBeInTheDocument();
  });

  it("routes 'pending' to the pending icon, not the failed icon", () => {
    render(<NameCell {...baseProps} syncStatus="pending" />);

    expect(screen.queryByTestId("sync-status-failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-status-pending")).toBeInTheDocument();
  });

  // `synced` and `undefined` are the row's null states — they intentionally
  // render no sync-status icon at all. The broad `/^sync-status-/` regex
  // catches any future icon leaking into these branches.
  it("renders no sync-status icon when syncStatus is 'synced'", () => {
    render(<NameCell {...baseProps} syncStatus="synced" />);

    expect(screen.queryByTestId(/^sync-status-/)).not.toBeInTheDocument();
  });

  it("renders no sync-status icon when syncStatus is undefined", () => {
    // Most `FormattedUserFile` rows arrive without a `syncStatus` set; the
    // icon switch must stay silent in that case so non-synced legacy rows
    // don't sprout a stray badge.
    render(<NameCell {...baseProps} syncStatus={undefined} />);

    expect(screen.queryByTestId(/^sync-status-/)).not.toBeInTheDocument();
  });
});

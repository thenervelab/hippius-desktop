/**
 * macOS sync-widget smoke test (WebdriverIO + tauri-plugin-webdriver).
 *
 * Drives the REAL widget in a REAL WKWebView via the backend-free bridge on the
 * `/e2e/sync-widget` route (`window.__e2ePushSyncFrame`), with no login / funded
 * account / live hcfs-server. It asserts the exact same display invariants the
 * jsdom replay harness checks (`app/(pages)/__tests__/syncWidgetReplay.*`) but
 * against the production renderer/CSS/layout — the gap an E2E layer fills:
 *   1. mid-transfer: ring shows a percent AND a NON-ZERO "transferred/total"
 *      (the "0B / 16%" screenshot can't reproduce);
 *   2. completion: ring reaches 100% and the card reads "Complete".
 *
 * The frames are minimal inline `SyncSnapshot`-shaped objects (kept here so the
 * spec is self-contained and needs no `@/`-alias resolution under WDIO). The
 * canonical scenarios live in syncWidgetReplay.invariants.ts.
 */

// A snapshot frame. Only the fields the widget reads are populated; the rest
// mirror EMPTY_SNAPSHOT defaults. Typed loosely (the real type lives behind a
// `@/` alias that WDIO's ts-node does not resolve).
type Frame = Record<string, unknown>;

function baseFrame(over: Frame): Frame {
  return {
    isActive: true,
    overallPercent: 0,
    progressBytes: 0,
    bytesExpected: 0,
    totalFiles: 1,
    completedFiles: 0,
    failedFiles: 0,
    retryInSecs: 0,
    lastError: null,
    expectedUploads: 1,
    expectedDownloads: 0,
    expectedLocalDeletes: 0,
    expectedRemoteDeletes: 0,
    startedAt: 1_700_000_000_000,
    completedAt: null,
    files: [],
    widgetState: "active",
    widgetVisible: true,
    combinedProgressBytes: 0,
    combinedBytesExpected: 0,
    deletedCount: 0,
    syncedCount: 0,
    actualTotal: 1,
    statusVariant: "progress",
    syncDirection: "upload",
    effectiveInProgress: true,
    effectiveCompleted: false,
    ...over,
  };
}

const TOTAL = 260_070_000;

const midTransfer = baseFrame({
  overallPercent: 16,
  progressBytes: 41_600_000,
  bytesExpected: TOTAL,
  combinedProgressBytes: 41_600_000,
  combinedBytesExpected: TOTAL * 2,
  files: [
    {
      path: "/Air-261.dmg",
      fileName: "Air-261.dmg",
      label: "default",
      action: "upload",
      status: "inProgress",
      progressPercent: 16,
      bytesEncrypted: 0,
      bytesTransferred: 41_600_000,
      totalBytes: TOTAL,
    },
  ],
});

const completed = baseFrame({
  isActive: false,
  overallPercent: 100,
  progressBytes: TOTAL,
  bytesExpected: TOTAL,
  combinedProgressBytes: TOTAL * 2,
  combinedBytesExpected: TOTAL * 2,
  completedFiles: 1,
  syncedCount: 1,
  files: [
    {
      path: "/Air-261.dmg",
      fileName: "Air-261.dmg",
      label: "default",
      action: "upload",
      status: "completed",
      progressPercent: 100,
      bytesEncrypted: 0,
      bytesTransferred: TOTAL,
      totalBytes: TOTAL,
    },
  ],
  widgetState: "completed",
  statusVariant: "success",
  effectiveInProgress: false,
  effectiveCompleted: true,
});

async function pushFrame(frame: Frame): Promise<void> {
  await browser.execute((f) => {
    (
      window as unknown as { __e2ePushSyncFrame?: (frame: unknown) => void }
    ).__e2ePushSyncFrame?.(f);
  }, frame);
}

describe("sync widget (macOS WKWebView smoke)", () => {
  before(async () => {
    // The harness is served over HTTP (baseUrl) by the static server in
    // wdio.conf.ts — a raw debug binary doesn't serve the embedded `tauri://`
    // assets, and the harness needs no Tauri IPC. The no-trailingSlash static
    // export emits `/e2e/sync-widget.html`.
    await browser.url("/e2e/sync-widget.html");
    await browser.$('body[data-e2e-sync-ready="1"]').waitForExist({ timeout: 20_000 });
  });

  it("shows a non-zero transferred figure while a large file is mid-upload", async () => {
    await pushFrame(midTransfer);

    const ringLabel = browser.$('[data-testid="overall-progress-label"]');
    await ringLabel.waitForExist({ timeout: 10_000 });
    await expect(ringLabel).toHaveText("16%");

    // The card must NOT show the intent-overlay "0B" at 16% — it shows the
    // byte-granular transferred figure. ~41.6MB of 260.07MB.
    const card = browser.$('[data-testid="e2e-sync-host"]');
    await expect(card).not.toHaveText("0B/260.07MB", { containing: true });
    await expect(card).toHaveText("41.6MB/260.07MB", { containing: true });
  });

  it("reaches 100% and reads Complete on completion", async () => {
    await pushFrame(completed);

    const card = browser.$('[data-testid="e2e-sync-host"]');
    await expect(card).toHaveText("Complete", { containing: true });
    await expect(browser.$('[data-testid="overall-progress-label"]')).toHaveText("100%");
  });
});

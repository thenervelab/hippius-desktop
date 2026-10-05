import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRef } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { captureRecordingAtom, captureSupportedAtom } from "@/app/lib/capture/captureFlow";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/app/lib/featureFlags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/featureFlags")>()),
  SCREEN_CAPTURE_ENABLED: true,
}));
// The header's navigation and credit hooks reach for the router and the
// wallet; only the toolbar's capture controls are under test here.
vi.mock("@/lib/hooks/useFilesNavigation", () => ({ useFilesNavigation: () => ({ navigateToFilesView: vi.fn() }) }));
vi.mock("@/app/lib/hooks/useNavigationLoader", () => ({ default: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/hooks/useCreditCheck", () => ({ useCreditCheck: () => ({ requireUploadRoom: vi.fn() }) }));

// The upload dialogs and the File button bring the wallet and the sync
// config with them; the capture buttons sit beside them, not inside.
vi.mock("../FolderUploadDialog", () => ({ default: () => null }));
vi.mock("../FolderToFolderUploadDialog", () => ({ default: () => null }));
vi.mock("../AddFileButton", () => ({ default: () => <button type="button">File</button> }));

import DriveHeader from "../DriveHeader";

const noop = () => {};

function renderHeader(props: { isReadOnlyDrive?: boolean; browsedSharedDrive?: { ownerSs58: string; folderHash: string } | null }) {
  const store = createStore();
  store.set(captureSupportedAtom, true);
  store.set(captureRecordingAtom, true);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Provider store={store}>
      <DriveHeader
        formattedStorageSize="1 GB"
        allFilteredDataLength={0}
        viewMode="list"
        setViewMode={noop}
        searchTerm=""
        handleSearchChange={noop}
        activeFilters={[]}
        handleRemoveFilter={noop}
        refetchUserFiles={noop}
        addButtonRef={createRef()}
        selectedFileSizes={[]}
        onFileExtensionChange={noop}
        onDateRangeChange={noop}
        onFileSizesChange={noop}
        openDriveLabel="Work"
        openDriveDisplayName="Work"
        breadcrumbSegments={[]}
        {...props}
      />
    </Provider>
    </QueryClientProvider>,
  );
}

function expectBoth() {
  const group = screen.getByRole("group", { name: "Screen capture" });
  expect(within(group).getByRole("button", { name: "Screenshot" })).toBeInTheDocument();
  expect(within(group).getByRole("button", { name: "Record" })).toBeInTheDocument();
}

/**
 * Inside every drive. A capture is filed in the capture drive the user
 * chose, not the drive on screen, so the buttons do not follow the open
 * drive's role: a Viewer on somebody else's drive still gets them.
 */
describe("the capture buttons inside a drive", () => {
  it("are in the toolbar of the user's own drive", () => {
    renderHeader({});
    expectBoth();
  });

  it("are in the toolbar of a shared drive the user may only view", () => {
    renderHeader({ isReadOnlyDrive: true, browsedSharedDrive: { ownerSs58: "5Owner", folderHash: "abc" } });
    expectBoth();
    // The same header offers the Viewer no way to write.
    expect(screen.queryByRole("button", { name: /^File$/ })).toBeNull();
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const onboarding = readFileSync(join(here, "../DriveOnboarding.tsx"), "utf8");

/**
 * The folder list's toolbar. DriveOnboarding is the whole Drive page (plans,
 * banners, dialogs), too much to render for one row; its source is pinned.
 */
describe("the capture buttons on the Drive main page", () => {
  const toolbar = onboarding.slice(onboarding.indexOf("headerAction={"), onboarding.indexOf("onOpenRow={handleOpenRow}"));

  it("lead the folder list's toolbar at its compact size", () => {
    expect(toolbar).toContain('<CaptureButtons size="compact" />');
    expect(toolbar.indexOf("<CaptureButtons")).toBeLessThan(toolbar.indexOf("UPLOAD_FOLDER_BUTTON_LABEL"));
  });

  // Uploads need a drive picked here; a capture does not.
  it("are not gated on being able to upload", () => {
    expect(toolbar.indexOf("<CaptureButtons")).toBeLessThan(toolbar.indexOf("{canUpload &&"));
  });

  it("replace the old Capture dropdown", () => {
    expect(onboarding).not.toContain("CaptureMenu");
  });
});
